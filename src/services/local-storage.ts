import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { BlobDownload, BlobStorage, StoredBlob } from "./blob-storage";

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

    async get(key: string): Promise<StoredBlob | undefined> {
        const file = Bun.file(this.path(key));
        const exists = await file.exists();
        if (!exists) return undefined;
        return { size: file.size, stream: () => file.stream() };
    }

    async read(key: string): Promise<BlobDownload | undefined> {
        const file = Bun.file(this.path(key));
        const exists = await file.exists();
        return exists ? { file } : undefined;
    }

    async write(key: string, data: Uint8Array, _contentType: string) {
        const path = this.path(key);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, data);
    }

    async delete(key: string) {
        await unlink(this.path(key)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
        });
    }
}
