import type { BlobStorage } from "../services/blob-storage";
import { LocalStorage } from "../services/local-storage";
import { S3Storage } from "../services/s3-storage";
import { StorageConfiguration } from "../services/storage-config";
import { Tracing } from "../telemetry/tracing";

export class StorageFactory {
    constructor(private readonly config = new StorageConfiguration()) {}

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
                return new LocalStorage(this.config.directory);
            }
            const { bucket, region, endpoint } = this.config;
            if (!bucket || !region)
                throw new Error(
                    "S3_BUCKET and AWS_REGION are required for S3 storage",
                );
            return new S3Storage(
                new Bun.S3Client({
                    bucket,
                    region,
                    ...(endpoint ? { endpoint } : {}),
                }),
            );
        });
    }
}
