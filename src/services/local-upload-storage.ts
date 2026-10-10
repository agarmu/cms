import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ForbiddenError } from "../lib/errors";
import { ImageTooLargeError, InvalidImageError } from "./image-storage";
import { LocalStorage } from "./local-storage";
import type { BlobUpload } from "./blob-storage";

export class LocalUploadStorage extends LocalStorage {
    private readonly uploads = new Map<
        string,
        { key: string; contentType: string; expires: number }
    >();

    constructor(
        directory: string,
        private readonly baseUrl: URL,
        private readonly maxBytes: number,
    ) {
        super(directory);
    }

    async createUpload(
        key: string,
        contentType: string,
        expiresIn: number,
    ): Promise<BlobUpload> {
        this.path(key);
        for (const [token, ticket] of this.uploads) {
            if (ticket.expires <= Date.now()) this.uploads.delete(token);
        }
        const token = randomUUID();
        this.uploads.set(token, {
            key,
            contentType,
            expires: Date.now() + expiresIn * 1000,
        });
        return {
            url: new URL("/api/local-uploads/" + token, this.baseUrl).href,
            method: "PUT",
            headers: { "Content-Type": contentType },
        };
    }

    async receive(
        token: string,
        request: Request,
        checkActive: (key: string) => Promise<void>,
    ) {
        const ticket = this.uploads.get(token);
        if (!ticket)
            throw new ForbiddenError("Invalid or already used upload URL");
        const active = async () => {
            if (ticket.expires <= Date.now())
                throw new ForbiddenError("Upload URL has expired");
            await checkActive(ticket.key);
        };
        await active();
        if (request.headers.get("Content-Type") !== ticket.contentType)
            throw new InvalidImageError("Upload Content-Type does not match");
        if (Number(request.headers.get("Content-Length")) > this.maxBytes)
            throw new ImageTooLargeError("Image is too large");
        const reader = request.body?.getReader();
        if (!reader) throw new InvalidImageError("Image must not be empty");
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > this.maxBytes)
                    throw new ImageTooLargeError("Image is too large");
                chunks.push(value);
            }
        } finally {
            void reader.cancel().catch(() => {});
            reader.releaseLock();
        }
        if (!bytes) throw new InvalidImageError("Image must not be empty");
        await active();
        if (!this.uploads.delete(token))
            throw new ForbiddenError("Upload URL has already been used");
        const path = this.path(ticket.key);
        const temporary = path + "." + randomUUID() + ".tmp";
        try {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(temporary, Buffer.concat(chunks, bytes));
            await active();
            await rename(temporary, path);
        } catch (error) {
            this.uploads.set(token, ticket);
            throw error;
        } finally {
            await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
            });
        }
    }
}
