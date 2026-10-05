import { Telemetry } from "../telemetry/setup";
import { TelemetryConfiguration } from "../telemetry/config";

export class ApplicationProcess {
    constructor(
        private readonly env: Record<string, string | undefined> = process.env,
    ) {}

    async run() {
        const telemetry = new Telemetry(
            TelemetryConfiguration.fromEnv(this.env),
        );
        telemetry.start();
        try {
            // Keep driver imports behind telemetry registration.
            const [{ ApplicationConfig }, { ApplicationRuntime }] =
                await Promise.all([import("./config"), import("./runtime")]);
            const runtime = await new ApplicationRuntime(
                ApplicationConfig.fromEnv(this.env),
            ).start();
            const shutdown = Promise.withResolvers<void>();
            const stop = () => shutdown.resolve();
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
            try {
                console.info("Listening on " + runtime.url);
                await shutdown.promise;
            } finally {
                process.off("SIGINT", stop);
                process.off("SIGTERM", stop);
                await runtime.stop();
            }
        } finally {
            await telemetry.stop();
        }
    }
}
