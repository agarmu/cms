import { WorkerConfiguration } from "./worker-config";
import { expect, test } from "bun:test";
import { BackgroundWorker } from "./background-worker";

test("stopping waits for active tasks and prevents another cycle", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const errors: Error[] = [];
    let runs = 0;
    let finished = false;
    const worker = new BackgroundWorker(
        {
            tasks: [
                async () => {
                    runs++;
                    started.resolve();
                    await release.promise;
                    finished = true;
                },
            ],
            reportError: (error) => errors.push(error),
        },
        new WorkerConfiguration({ intervalMs: 1 }),
    ).start();
    try {
        await started.promise;
        const stopping = worker.stop();
        expect(finished).toBe(false);
        release.resolve();
        await stopping;
        expect(finished).toBe(true);
        await Bun.sleep(10);
        expect(runs).toBe(1);
        expect(errors).toEqual([]);
    } finally {
        release.resolve();
        await worker.stop();
    }
});

test("a failing task does not prevent other tasks or the next cycle", async () => {
    const secondCycle = Promise.withResolvers<void>();
    const failure = new Error("Temporary failure");
    const errors: Error[] = [];
    let runs = 0;
    const worker = new BackgroundWorker(
        {
            tasks: [
                () => {
                    throw failure;
                },
                async () => {
                    if (++runs === 2) secondCycle.resolve();
                },
            ],
            reportError: (error) => errors.push(error),
        },
        new WorkerConfiguration({ intervalMs: 1 }),
    ).start();
    try {
        await secondCycle.promise;
        await worker.stop();
        expect(runs).toBe(2);
        expect(errors).toEqual([failure, failure]);
    } finally {
        await worker.stop();
    }
});
