import { z } from "zod";

export type WorkerSettings = {
    intervalMs?: number;
    batchSize?: number;
    uploadWaitMs?: number;
    uploadRetryMs?: number;
    failureRetryMs?: number;
};

export class WorkerConfiguration {
    private static readonly schema = z.object({
        intervalMs: z.int().positive().default(5000),
        batchSize: z.int().positive().default(10),
        uploadWaitMs: z
            .int()
            .positive()
            .default(60 * 60 * 1000),
        uploadRetryMs: z.int().positive().default(10_000),
        failureRetryMs: z.int().positive().default(30_000),
    });

    readonly intervalMs: number;
    readonly batchSize: number;
    readonly uploadWaitMs: number;
    readonly uploadRetryMs: number;
    readonly failureRetryMs: number;

    constructor(values: WorkerSettings = {}) {
        const settings = WorkerConfiguration.schema.parse(values);
        this.intervalMs = settings.intervalMs;
        this.batchSize = settings.batchSize;
        this.uploadWaitMs = settings.uploadWaitMs;
        this.uploadRetryMs = settings.uploadRetryMs;
        this.failureRetryMs = settings.failureRetryMs;
    }
}
