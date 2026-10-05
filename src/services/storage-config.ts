export type StorageSettings = {
    backend?: "s3" | "local";
    directory?: string;
    bucket?: string;
    region?: string;
    endpoint?: string;
};

export class StorageConfiguration {
    readonly backend: "s3" | "local";
    readonly directory: string | undefined;
    readonly bucket: string | undefined;
    readonly region: string | undefined;
    readonly endpoint: string | undefined;

    constructor(values: StorageSettings = {}) {
        this.backend = values.backend ?? "s3";
        this.directory = values.directory;
        this.bucket = values.bucket;
        this.region = values.region;
        this.endpoint = values.endpoint;
    }

    static fromEnv(env: Record<string, string | undefined> = process.env) {
        return new StorageConfiguration({
            backend: env["IMAGE_STORAGE_DIR"] ? "local" : "s3",
            ...(env["IMAGE_STORAGE_DIR"]
                ? { directory: env["IMAGE_STORAGE_DIR"] }
                : {}),
            ...(env["S3_BUCKET"] ? { bucket: env["S3_BUCKET"] } : {}),
            ...(env["AWS_REGION"] ? { region: env["AWS_REGION"] } : {}),
            ...(env["S3_ENDPOINT"] ? { endpoint: env["S3_ENDPOINT"] } : {}),
        });
    }
}
