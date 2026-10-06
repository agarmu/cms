import { Tracing } from "../telemetry/tracing";
import { WorkerConfiguration } from "./worker-config";

export class BackgroundWorker {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private running: Promise<void> | undefined;
    private stopped = false;
    private started = false;

    constructor(
        private readonly options: {
            tasks: (() => Promise<void>)[];
            reportError: (error: Error) => void;
        },
        private readonly config = new WorkerConfiguration(),
    ) {}

    start() {
        return Tracing.withSyncSpan(
            "worker.start",
            () => {
                if (this.stopped) throw new Error("Worker has stopped");
                if (!this.started) {
                    this.started = true;
                    this.timer = setTimeout(
                        () => this.run(),
                        this.config.interval,
                    );
                }
                return this;
            },
            { "worker.interval_ms": this.config.interval },
        );
    }

    private run() {
        this.running = Tracing.withRootSpan(
            "worker.cycle",
            async () => {
                const results = await Promise.allSettled(
                    this.options.tasks.map((task) =>
                        Promise.resolve().then(task),
                    ),
                );
                for (const result of results) {
                    if (result.status === "rejected") {
                        Tracing.recordSpanError(result.reason);
                        this.options.reportError(
                            result.reason instanceof Error
                                ? result.reason
                                : new Error(String(result.reason)),
                        );
                    }
                }
            },
            { "worker.tasks.count": this.options.tasks.length },
        ).finally(() => {
            if (!this.stopped)
                this.timer = setTimeout(() => this.run(), this.config.interval);
        });
    }

    stop() {
        return Tracing.withSpan("worker.stop", async () => {
            this.stopped = true;
            clearTimeout(this.timer);
            await this.running;
        });
    }
}
