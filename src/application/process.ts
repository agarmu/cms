import { Telemetry } from "../telemetry/setup";
import { ApplicationConfig } from "./config";

export class ApplicationProcess {
    constructor(
        private readonly configPath = "config.toml",
        private readonly secretsPath = "secrets.toml",
    ) {}

    async run() {
        const config = await ApplicationConfig.fromFiles(
            this.configPath,
            this.secretsPath,
        );
        const telemetry = new Telemetry(config.telemetry);
        try {
            telemetry.start();
            // Keep driver imports behind telemetry registration.
            const { ApplicationRuntime } = await import("./runtime");
            const runtime = await new ApplicationRuntime(config, {
                reportError: (error) => {
                    console.error(error);
                    telemetry.log(error.message, "ERROR");
                },
            }).start();
            const shutdown = Promise.withResolvers<void>();
            const stop = () => shutdown.resolve();
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
            try {
                const address = config.unix
                    ? "unix:" + config.unix
                    : runtime.url.toString();
                console.info("Listening on " + address);
                telemetry.log("Listening on " + address);
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
