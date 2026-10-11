// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { ConflictError, NotFoundError } from "../lib/errors";
import { ImageConfiguration } from "./image-config";
import type { BlobStorage } from "./blob-storage";
import { Tracing } from "../telemetry/tracing";

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

export class ImageStorage {
    private static readonly assetFilename = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
    private readonly supportedFormats = new Set([
        "jpeg",
        "png",
        "webp",
        "avif",
        "tiff",
    ]);
    private readonly inputOptions;

    constructor(
        private readonly storage: BlobStorage,
        private readonly config = new ImageConfiguration(),
    ) {
        this.inputOptions = {
            failOn: "error",
            limitInputPixels: config.maxPixels,
        } as const;
    }

    // Only decoder failures are invalid images. Database and storage failures keep
    // their original error types so the worker can report and retry them.
    private async decodeImage<T>(decode: () => Promise<T>): Promise<T> {
        try {
            return await decode();
        } catch (error) {
            throw new InvalidImageError("Unsupported or invalid image", {
                cause: error,
            });
        }
    }

    @Tracing.traced("image.storage.upload.create")
    async createUpload(photoId: string, uploadId: string, contentType: string) {
        if (!this.storage.createUpload)
            throw new Error("Storage does not support direct uploads");
        const key = this.originalKey(photoId, uploadId);
        const expiresIn = 900;
        return {
            ...(await this.storage.createUpload(key, contentType, expiresIn)),
            uploadId,
            key,
            expiresIn,
        };
    }

    private originalKey(photoId: string, uploadId: string) {
        return `originals/${photoId}/${uploadId}`;
    }

    async uploadOriginal(
        photoId: string,
        uploadId: string,
        contentType: string,
        dataBase64: string,
    ) {
        if (dataBase64.length > Math.ceil(this.config.maxBytes / 3) * 4)
            throw new ImageTooLargeError("Image is too large");
        const bytes = Buffer.from(dataBase64, "base64");
        if (!bytes.length || bytes.toString("base64") !== dataBase64)
            throw new InvalidImageError("Image data must be valid base64");
        if (bytes.length > this.config.maxBytes)
            throw new ImageTooLargeError("Image is too large");
        await this.storage.write(
            this.originalKey(photoId, uploadId),
            bytes,
            contentType,
        );
    }

    async deleteOriginal(photoId: string, uploadId: string) {
        await this.storage.delete(this.originalKey(photoId, uploadId));
    }

    @Tracing.traced("image.storage.process")
    async processUpload(
        photoId: string,
        uploadId: string,
        checkActive: () => Promise<void> = async () => {},
    ) {
        Tracing.setSpanAttributes({
            "photo.id": photoId,
            "image.upload.id": uploadId,
        });
        await checkActive();
        const file = await this.storage.get(
            this.originalKey(photoId, uploadId),
        );
        if (!file)
            throw new MissingOriginalError(
                "Original image has not been uploaded",
            );
        const { size } = file;
        if (size > this.config.maxBytes)
            throw new ImageTooLargeError(
                `Image must not exceed ${this.config.maxBytes / (1024 * 1024)} MiB`,
            );
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
                if (bytes > this.config.maxBytes)
                    throw new ImageTooLargeError(
                        `Image must not exceed ${this.config.maxBytes / (1024 * 1024)} MiB`,
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

    @Tracing.traced("image.storage.read")
    async read(photoId: string, filename: string, expiresIn = 900) {
        // Only a single filename beneath a validated photo ID may be read.
        if (!ImageStorage.assetFilename.test(filename)) return undefined;
        const key = `images/${photoId}/${filename}`;
        return this.storage.read(key, expiresIn);
    }

    @Tracing.traced("image.storage.delete")
    async deleteAsset(photoId: string, filename: string) {
        if (!ImageStorage.assetFilename.test(filename))
            throw new InvalidAssetLocationError("Invalid image asset filename");
        await this.storage.delete(`images/${photoId}/${filename}`);
    }

    @Tracing.traced("image.storage.publish")
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
        const cleanup = () =>
            Tracing.withSpan(
                "image.storage.cleanup",
                async () => {
                    // Wait for every deletion before ending the cleanup span, even on failure.
                    const results = await Promise.allSettled(
                        keys.map((key) => this.storage.delete(key)),
                    );
                    const failures = results
                        .filter((result) => result.status === "rejected")
                        .map((result) => result.reason);
                    if (failures.length) throw failures[0];
                },
                { "image.assets.count": keys.length },
            );
        try {
            for (const image of prepared) {
                await checkActive();
                const filename = `${generationId}-${image.filename}`;
                const key = `images/${photoId}/${filename}`;
                keys.push(key);
                await this.storage.write(key, image.data, image.mimeType);
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
        Tracing.setSpanAttributes({ "image.assets.count": assets.length });
        return { assets, cleanup };
    }

    @Tracing.traced("image.prepare")
    private async prepare(input: Uint8Array, checkActive: () => Promise<void>) {
        // Validate the original with the decoder rather than the client-supplied content type.
        const metadata = await Tracing.withSpan("image.metadata", () =>
            this.decodeImage(() => sharp(input, this.inputOptions).metadata()),
        );
        const format =
            metadata.format === "heif" && metadata.compression === "av1"
                ? "avif"
                : metadata.format;
        const supported = this.supportedFormats.has(format ?? "");
        if (!metadata.width || !metadata.height || !supported) {
            throw new InvalidImageError("Unsupported image type");
        }
        Tracing.setSpanAttributes({
            "image.format": format,
            "image.width": metadata.width,
            "image.height": metadata.height,
        });
        const images: PreparedImage[] = [];
        const minSide = Math.min(metadata.width, metadata.height);
        for (const variant of this.config.variants) {
            if (minSide < variant.minSide) continue;
            await checkActive();
            const { data, info } = await Tracing.withSpan(
                "image.convert",
                () =>
                    this.decodeImage(() =>
                        sharp(input, this.inputOptions)
                            .rotate()
                            .resize({
                                width: variant.minSide,
                                height: variant.minSide,
                                fit: "outside",
                                withoutEnlargement: true,
                            })
                            .webp({ quality: this.config.quality })
                            .toBuffer({ resolveWithObject: true }),
                    ),
                {
                    "image.variant": variant.name,
                    "image.variant.min_side": variant.minSide,
                },
            );
            images.push({
                filename: `${variant.name}.webp`,
                data,
                mimeType: "image/webp",
                dimensions: { width: info.width, height: info.height },
            });
        }
        if (!images.length) {
            const { data, info } = await this.decodeImage(() =>
                sharp(input, this.inputOptions)
                    .rotate()
                    .webp({ quality: this.config.quality })
                    .toBuffer({ resolveWithObject: true }),
            );
            images.push({
                filename: "original.webp",
                data,
                mimeType: "image/webp",
                dimensions: { width: info.width, height: info.height },
            });
        }
        return images;
    }
}
