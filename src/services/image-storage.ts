import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { ConflictError, NotFoundError } from "../lib/errors";

const variants = [
    { name: "large", minSide: 1920 },
    { name: "medium", minSide: 960 },
    { name: "thumbnail", minSide: 320 },
] as const;
const inputOptions = { failOn: "error", limitInputPixels: 60_000_000 } as const;
const assetFilename = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const supportedFormats = {
    jpeg: true,
    png: true,
    webp: true,
    avif: true,
    tiff: true,
} as const;

export type ProcessedAsset = {
    width: number;
    height: number;
    assetLocation: string;
};
type PreparedImage = {
    filename: string;
    data: Uint8Array;
    mimeType: string;
    dimensions: { width: number; height: number };
};
export class MissingOriginalError extends NotFoundError {}
export class UploadCancelledError extends ConflictError {}
export class InvalidImageError extends Error {}
export class ImageTooLargeError extends Error {}
export class InvalidAssetLocationError extends Error {}
export const maxImageBytes = 25 * 1024 * 1024;

// Only decoder failures are invalid images. Database and storage failures keep
// their original error types so the worker can report and retry them.
async function decodeImage<T>(decode: () => Promise<T>): Promise<T> {
    try {
        return await decode();
    } catch (error) {
        throw new InvalidImageError("Unsupported or invalid image", {
            cause: error,
        });
    }
}

export function imageAssetUrl(photoId: string, filename: string) {
    return `/images/${encodeURIComponent(photoId)}/${encodeURIComponent(filename)}`;
}

export type ImageS3Client = Pick<
    Bun.S3Client,
    "presign" | "write" | "delete"
> & {
    file(key: string): Pick<Bun.S3File, "exists" | "stat" | "stream">;
};
type StorageBackend = { client: ImageS3Client } | { localDirectory: string };

export class ImageStorage {
    constructor(private readonly backend: StorageBackend) {}

    static fromEnv() {
        const localDirectory = process.env["IMAGE_STORAGE_DIR"];
        if (localDirectory) return new ImageStorage({ localDirectory });

        const bucket = process.env["S3_BUCKET"];
        const region = process.env["AWS_REGION"];
        if (!bucket || !region)
            throw new Error(
                "S3_BUCKET and AWS_REGION are required for image storage",
            );
        const endpoint = process.env["S3_ENDPOINT"];
        return new ImageStorage({
            client: new Bun.S3Client({
                bucket,
                region,
                ...(endpoint ? { endpoint } : {}),
            }),
        });
    }

    createUpload(photoId: string, uploadId: string, contentType: string) {
        if (!("client" in this.backend))
            throw new Error("Direct uploads require S3 storage");
        const key = this.originalKey(photoId, uploadId);
        const expiresIn = 900;
        return {
            uploadId,
            key,
            method: "PUT" as const,
            expiresIn,
            url: this.backend.client.presign(key, {
                method: "PUT",
                type: contentType,
                expiresIn,
            }),
            headers: { "Content-Type": contentType },
        };
    }

    private originalKey(photoId: string, uploadId: string) {
        return `originals/${photoId}/${uploadId}`;
    }

    async processUpload(
        photoId: string,
        uploadId: string,
        checkActive: () => Promise<void> = async () => {},
    ) {
        if (!("client" in this.backend))
            throw new Error("Direct uploads require S3 storage");
        await checkActive();
        const file = this.backend.client.file(
            this.originalKey(photoId, uploadId),
        );
        if (!(await file.exists()))
            throw new MissingOriginalError(
                "Original image has not been uploaded",
            );
        const { size } = await file.stat();
        if (size > maxImageBytes)
            throw new ImageTooLargeError("Image must not exceed 25 MiB");
        if (size === 0) throw new InvalidImageError("Image must not be empty");

        // Bound the download too, in case the object changed after the HEAD request.
        const reader = file.stream().getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.length;
                if (bytes > maxImageBytes)
                    throw new ImageTooLargeError(
                        "Image must not exceed 25 MiB",
                    );
                chunks.push(value);
            }
        } finally {
            try {
                await reader.cancel();
            } finally {
                reader.releaseLock();
            }
        }
        if (bytes === 0) throw new InvalidImageError("Image must not be empty");
        const input = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
            input.set(chunk, offset);
            offset += chunk.length;
        }
        await checkActive();
        return this.processAndStore(input, photoId, checkActive);
    }

    async read(
        photoId: string,
        filename: string,
    ): Promise<{ url: string } | { file: Bun.BunFile } | undefined> {
        // Only a single filename beneath a validated photo ID may be read.
        if (!assetFilename.test(filename)) return undefined;
        const key = `images/${photoId}/${filename}`;
        if ("client" in this.backend) {
            return {
                url: this.backend.client.presign(key, { expiresIn: 3600 }),
            };
        }
        const file = Bun.file(join(this.backend.localDirectory, key));
        return (await file.exists()) ? { file } : undefined;
    }

    async deleteAsset(photoId: string, filename: string) {
        if (!assetFilename.test(filename))
            throw new InvalidAssetLocationError("Invalid image asset filename");
        await this.remove(`images/${photoId}/${filename}`);
    }

    private async store(key: string, data: Uint8Array, mimeType: string) {
        if ("client" in this.backend) {
            await this.backend.client.write(key, data, { type: mimeType });
        } else {
            const path = join(this.backend.localDirectory, key);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, data);
        }
    }

    private async remove(key: string) {
        if ("client" in this.backend) {
            await this.backend.client.delete(key);
        } else {
            await unlink(join(this.backend.localDirectory, key)).catch(
                (error: NodeJS.ErrnoException) => {
                    if (error.code !== "ENOENT") throw error;
                },
            );
        }
    }

    private async processAndStore(
        input: Uint8Array,
        photoId: string,
        checkActive: () => Promise<void>,
    ) {
        // Decode every variant before writing anything; client errors cannot leave partial uploads.
        const prepared = await this.prepare(input, checkActive);
        const generationId = randomUUID();
        const assets: ProcessedAsset[] = [];
        const keys: string[] = [];
        const cleanup = async () => {
            await Promise.all(keys.map((key) => this.remove(key)));
        };
        try {
            for (const image of prepared) {
                await checkActive();
                const filename = `${generationId}-${image.filename}`;
                const key = `images/${photoId}/${filename}`;
                keys.push(key);
                await this.store(key, image.data, image.mimeType);
                assets.push({ ...image.dimensions, assetLocation: filename });
            }
            await checkActive();
        } catch (error) {
            try {
                await cleanup();
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    "Image upload and cleanup failed",
                );
            }
            throw error;
        }
        return { assets, cleanup };
    }

    private async prepare(input: Uint8Array, checkActive: () => Promise<void>) {
        // Validate the original with the decoder rather than the client-supplied content type.
        const metadata = await decodeImage(() =>
            sharp(input, inputOptions).metadata(),
        );
        const format =
            metadata.format === "heif" && metadata.compression === "av1"
                ? "avif"
                : metadata.format;
        const supported =
            supportedFormats[format as keyof typeof supportedFormats];
        if (!metadata.width || !metadata.height || !supported) {
            throw new InvalidImageError("Unsupported image type");
        }
        const images: PreparedImage[] = [];
        const minSide = Math.min(metadata.width, metadata.height);
        for (const variant of variants) {
            if (minSide < variant.minSide) continue;
            await checkActive();
            const { data, info } = await decodeImage(() =>
                sharp(input, inputOptions)
                    .rotate()
                    .resize({
                        width: variant.minSide,
                        height: variant.minSide,
                        fit: "outside",
                        withoutEnlargement: true,
                    })
                    .webp({ quality: 82 })
                    .toBuffer({ resolveWithObject: true }),
            );
            images.push({
                filename: `${variant.name}.webp`,
                data,
                mimeType: "image/webp",
                dimensions: { width: info.width, height: info.height },
            });
        }
        return images;
    }
}
