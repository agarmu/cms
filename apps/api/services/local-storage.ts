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

import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { BlobDownload, BlobStorage, StoredBlob } from "./blob-storage";
import { Tracing } from "../telemetry/tracing";

export class LocalStorage implements BlobStorage {
    private readonly directory: string;

    constructor(directory: string) {
        this.directory = resolve(directory);
    }

    protected path(key: string) {
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

    @Tracing.traced("storage.local.get")
    async get(key: string): Promise<StoredBlob | undefined> {
        const file = Bun.file(this.path(key));
        const exists = await file.exists();
        Tracing.setSpanAttributes({ "storage.object.exists": exists });
        if (!exists) return undefined;
        Tracing.setSpanAttributes({ "storage.object.size": file.size });
        return {
            size: file.size,
            stream: () =>
                Tracing.tracedStream("storage.local.download", () =>
                    file.stream(),
                ),
        };
    }

    @Tracing.traced("storage.local.read")
    async read(key: string): Promise<BlobDownload | undefined> {
        const file = Bun.file(this.path(key));
        const exists = await file.exists();
        Tracing.setSpanAttributes({ "storage.object.exists": exists });
        return exists ? { file } : undefined;
    }

    @Tracing.traced("storage.local.write")
    async write(key: string, data: Uint8Array, contentType: string) {
        Tracing.setSpanAttributes({
            "storage.object.size": data.byteLength,
            "storage.content_type": contentType,
        });
        const path = this.path(key);
        await mkdir(dirname(path), { recursive: true });
        const temporary = path + "." + randomUUID() + ".tmp";
        try {
            await writeFile(temporary, data);
            await rename(temporary, path);
        } finally {
            await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
            });
        }
    }

    @Tracing.traced("storage.local.delete")
    async delete(key: string) {
        await unlink(this.path(key)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
        });
    }
}
