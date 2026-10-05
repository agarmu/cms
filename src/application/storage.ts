import type { BlobStorage } from "../services/blob-storage";
import { LocalStorage } from "../services/local-storage";
import { S3Storage } from "../services/s3-storage";

export function createBlobStorage(
    env: Record<string, string | undefined> = process.env,
): BlobStorage {
    const directory = env["IMAGE_STORAGE_DIR"];
    if (directory) return new LocalStorage(directory);

    const bucket = env["S3_BUCKET"];
    const region = env["AWS_REGION"];
    if (!bucket || !region)
        throw new Error("S3_BUCKET and AWS_REGION are required for S3 storage");
    const endpoint = env["S3_ENDPOINT"];
    return new S3Storage(
        new Bun.S3Client({ bucket, region, ...(endpoint ? { endpoint } : {}) }),
    );
}
