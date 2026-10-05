import { startTelemetry } from "./telemetry/setup";

const telemetry = startTelemetry();
try {
    // Register telemetry before loading database drivers and application modules.
    const [{ readConfig }, { startApplication }] = await Promise.all([
        import("./application/config"),
        import("./application/runtime"),
    ]);
    const application = await startApplication(readConfig());
    const shutdown = Promise.withResolvers<void>();
    const stop = () => shutdown.resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
        console.info(`Listening on ${application.url}`);
        await shutdown.promise;
    } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await application.stop();
    }
} finally {
    await telemetry?.shutdown();
}
