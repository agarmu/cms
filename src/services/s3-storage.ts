import type {
    BlobDownload,
    BlobStorage,
    BlobUpload,
    StoredBlob,
} from "./blob-storage";

export type S3Client = Pick<Bun.S3Client, "presign" | "write" | "delete"> & {
    file(key: string): Pick<Bun.S3File, "exists" | "stat" | "stream">;
};

export class S3Storage implements BlobStorage {
    constructor(private readonly client: S3Client) {}

    async createUpload(
        key: string,
        contentType: string,
        expiresIn: number,
    ): Promise<BlobUpload> {
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

    async get(key: string): Promise<StoredBlob | undefined> {
        const file = this.client.file(key);
        const exists = await file.exists();
        if (!exists) return undefined;
        const { size } = await file.stat();
        return { size, stream: () => file.stream() };
    }

    async read(key: string, expiresIn: number): Promise<BlobDownload> {
        return { url: this.client.presign(key, { expiresIn }) };
    }

    async write(key: string, data: Uint8Array, contentType: string) {
        await this.client.write(key, data, { type: contentType });
    }

    async delete(key: string) {
        await this.client.delete(key);
    }
}
