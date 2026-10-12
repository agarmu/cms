// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

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
