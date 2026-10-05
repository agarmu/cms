import {
    recordSpanError,
    withRootSpan,
    withSpan,
    withSyncSpan,
} from "../telemetry/tracing";

export function startBackgroundWorker(options: {
    tasks: (() => Promise<void>)[];
    reportError: (error: Error) => void;
    intervalMs?: number;
}) {
    const intervalMs = options.intervalMs ?? 5000;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let running: Promise<void> | undefined;
    const run = () => {
        running = withRootSpan(
            "worker.cycle",
            async () => {
                const results = await Promise.allSettled(
                    options.tasks.map((task) => Promise.resolve().then(task)),
                );
                for (const result of results) {
                    if (result.status === "rejected") {
                        recordSpanError(result.reason);
                        options.reportError(
                            result.reason instanceof Error
                                ? result.reason
                                : new Error(String(result.reason)),
                        );
                    }
                }
            },
            { "worker.tasks.count": options.tasks.length },
        ).finally(() => {
            // Schedule after all tasks finish so consecutive cycles cannot overlap.
            if (!stopped) timer = setTimeout(run, intervalMs);
        });
    };
    timer = withSyncSpan("worker.start", () => setTimeout(run, intervalMs), {
        "worker.interval_ms": intervalMs,
    });
    return () =>
        withSpan("worker.stop", async () => {
            stopped = true;
            clearTimeout(timer);
            await running;
        });
}
