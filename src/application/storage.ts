import type { BlobStorage } from "../services/blob-storage";
import { LocalStorage } from "../services/local-storage";
import { LocalUploadStorage } from "../services/local-upload-storage";
import { S3Storage } from "../services/s3-storage";
import { StorageConfiguration } from "../services/storage-config";
import { Tracing } from "../telemetry/tracing";

export class StorageFactory {
    constructor(
        private readonly config: StorageConfiguration,
        private readonly uploads?: { baseUrl: URL; maxBytes: number },
    ) {}

    create(): BlobStorage {
        return Tracing.withSyncSpan("storage.initialize", () => {
            Tracing.setSpanAttributes({
                "storage.backend": this.config.backend,
            });
            if (this.config.backend === "local") {
                if (!this.config.directory)
                    throw new Error(
                        "A directory is required for local storage",
                    );
                return this.uploads
                    ? new LocalUploadStorage(
                          this.config.directory,
                          this.uploads.baseUrl,
                          this.uploads.maxBytes,
                      )
                    : new LocalStorage(this.config.directory);
            }
            return new S3Storage(new Bun.S3Client(this.config.clientOptions()));
        });
    }
}
