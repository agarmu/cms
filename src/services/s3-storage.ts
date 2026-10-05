import type {
    BlobDownload,
    BlobStorage,
    BlobUpload,
    StoredBlob,
} from "./blob-storage";
import { SpanKind } from "@opentelemetry/api";
import { setSpanAttributes, traced, tracedStream } from "../telemetry/tracing";

export type S3Client = Pick<Bun.S3Client, "presign" | "write" | "delete"> & {
    file(key: string): Pick<Bun.S3File, "exists" | "stat" | "stream">;
};

export class S3Storage implements BlobStorage {
    constructor(private readonly client: S3Client) {}

    @traced("storage.s3.upload.sign")
    async createUpload(
        key: string,
        contentType: string,
        expiresIn: number,
    ): Promise<BlobUpload> {
        setSpanAttributes({
            "storage.content_type": contentType,
            "storage.url.expires_in": expiresIn,
        });
        return {
            url: this.client.presign(key, {
                method: "PUT",
                type: contentType,
                expiresIn,
            }),
            method: "PUT",
            headers: { "Content-Type": contentType },
        };
    }

    @traced("storage.s3.get", {}, { kind: SpanKind.CLIENT })
    async get(key: string): Promise<StoredBlob | undefined> {
        const file = this.client.file(key);
        const exists = await file.exists();
        setSpanAttributes({ "storage.object.exists": exists });
        if (!exists) return undefined;
        const { size } = await file.stat();
        setSpanAttributes({ "storage.object.size": size });
        return {
            size,
            stream: () =>
                tracedStream(
                    "storage.s3.download",
                    () => file.stream(),
                    {},
                    { kind: SpanKind.CLIENT },
                ),
        };
    }

    @traced("storage.s3.download.sign")
    async read(key: string, expiresIn: number): Promise<BlobDownload> {
        setSpanAttributes({ "storage.url.expires_in": expiresIn });
        return { url: this.client.presign(key, { expiresIn }) };
    }

    @traced("storage.s3.write", {}, { kind: SpanKind.CLIENT })
    async write(key: string, data: Uint8Array, contentType: string) {
        setSpanAttributes({
            "storage.object.size": data.byteLength,
            "storage.content_type": contentType,
        });
        await this.client.write(key, data, { type: contentType });
    }

    @traced("storage.s3.delete", {}, { kind: SpanKind.CLIENT })
    async delete(key: string) {
        await this.client.delete(key);
    }
}
