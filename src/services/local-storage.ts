import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { BlobDownload, BlobStorage, StoredBlob } from "./blob-storage";
import { setSpanAttributes, traced, tracedStream } from "../telemetry/tracing";

export class LocalStorage implements BlobStorage {
    private readonly directory: string;

    constructor(directory: string) {
        this.directory = resolve(directory);
    }

    private path(key: string) {
        const path = resolve(this.directory, key);
        const name = relative(this.directory, path);
        if (
            isAbsolute(key) ||
            !name ||
            name === ".." ||
            name.startsWith(`..${sep}`)
        ) {
            throw new Error(
                "Blob key must point to a file within the storage directory",
            );
        }
        return path;
    }

    @traced("storage.local.get")
    async get(key: string): Promise<StoredBlob | undefined> {
        const file = Bun.file(this.path(key));
        const exists = await file.exists();
        setSpanAttributes({ "storage.object.exists": exists });
        if (!exists) return undefined;
        setSpanAttributes({ "storage.object.size": file.size });
        return {
            size: file.size,
            stream: () =>
                tracedStream("storage.local.download", () => file.stream()),
        };
    }

    @traced("storage.local.read")
    async read(key: string): Promise<BlobDownload | undefined> {
        const file = Bun.file(this.path(key));
        const exists = await file.exists();
        setSpanAttributes({ "storage.object.exists": exists });
        return exists ? { file } : undefined;
    }

    @traced("storage.local.write")
    async write(key: string, data: Uint8Array, contentType: string) {
        setSpanAttributes({
            "storage.object.size": data.byteLength,
            "storage.content_type": contentType,
        });
        const path = this.path(key);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, data);
    }

    @traced("storage.local.delete")
    async delete(key: string) {
        await unlink(this.path(key)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
        });
    }
}
