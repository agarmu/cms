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

import type {
    BlobDownload,
    BlobStorage,
    BlobUpload,
    StoredBlob,
} from "./blob-storage";
import { SpanKind } from "@opentelemetry/api";
import { Tracing } from "../telemetry/tracing";

export type S3Client = Pick<Bun.S3Client, "presign" | "write" | "delete"> & {
    file(key: string): Pick<Bun.S3File, "exists" | "stat" | "stream">;
};

export class S3Storage implements BlobStorage {
    constructor(private readonly client: S3Client) {}

    @Tracing.traced("storage.s3.upload.sign")
    async createUpload(
        key: string,
        contentType: string,
        expiresIn: number,
    ): Promise<BlobUpload> {
        Tracing.setSpanAttributes({
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

    @Tracing.traced("storage.s3.get", {}, { kind: SpanKind.CLIENT })
    async get(key: string): Promise<StoredBlob | undefined> {
        const file = this.client.file(key);
        const exists = await file.exists();
        Tracing.setSpanAttributes({ "storage.object.exists": exists });
        if (!exists) return undefined;
        const { size } = await file.stat();
        Tracing.setSpanAttributes({ "storage.object.size": size });
        return {
            size,
            stream: () =>
                Tracing.tracedStream(
                    "storage.s3.download",
                    () => file.stream(),
                    {},
                    { kind: SpanKind.CLIENT },
                ),
        };
    }

    @Tracing.traced("storage.s3.download.sign")
    async read(key: string, expiresIn: number): Promise<BlobDownload> {
        Tracing.setSpanAttributes({ "storage.url.expires_in": expiresIn });
        const expiresAt = new Date(
            (Math.floor(Date.now() / 1000) + expiresIn) * 1000,
        );
        return { url: this.client.presign(key, { expiresIn }), expiresAt };
    }

    @Tracing.traced("storage.s3.write", {}, { kind: SpanKind.CLIENT })
    async write(key: string, data: Uint8Array, contentType: string) {
        Tracing.setSpanAttributes({
            "storage.object.size": data.byteLength,
            "storage.content_type": contentType,
        });
        await this.client.write(key, data, { type: contentType });
    }

    @Tracing.traced("storage.s3.delete", {}, { kind: SpanKind.CLIENT })
    async delete(key: string) {
        await this.client.delete(key);
    }
}
