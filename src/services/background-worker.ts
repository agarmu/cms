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
        running = Promise.allSettled(
            options.tasks.map((task) => Promise.resolve().then(task)),
        )
            .then((results) => {
                for (const result of results) {
                    if (result.status === "rejected") {
                        options.reportError(
                            result.reason instanceof Error
                                ? result.reason
                                : new Error(String(result.reason)),
                        );
                    }
                }
            })
            .finally(() => {
                // Schedule after all tasks finish so consecutive cycles cannot overlap.
                if (!stopped) timer = setTimeout(run, intervalMs);
            });
    };
    timer = setTimeout(run, intervalMs);
    return async () => {
        stopped = true;
        clearTimeout(timer);
        await running;
    };
}
