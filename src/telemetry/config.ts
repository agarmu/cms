export class TelemetryConfiguration {
    constructor(
        readonly enabled = true,
        readonly serviceName = "photos-cms",
    ) {}

    static fromEnv(env: Record<string, string | undefined> = process.env) {
        return new TelemetryConfiguration(
            env["OTEL_SDK_DISABLED"]?.toLowerCase() !== "true",
            env["OTEL_SERVICE_NAME"] ?? "photos-cms",
        );
    }
}
