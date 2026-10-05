import { z } from "zod";

export type WorkerSettings = {
    intervalMs?: number;
    batchSize?: number;
    uploadWaitMs?: number;
    uploadRetryMs?: number;
    failureRetryMs?: number;
    maxRetries?: number;
    multiplier?: number;
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
        maxRetries: z.int().nonnegative().default(5),
        multiplier: z.number().finite().gt(1).default(2),
    });

    readonly intervalMs: number;
    readonly batchSize: number;
    readonly uploadWaitMs: number;
    readonly uploadRetryMs: number;
    readonly failureRetryMs: number;
    readonly maxRetries: number;
    readonly multiplier: number;

    constructor(values: WorkerSettings = {}) {
        const settings = WorkerConfiguration.schema.parse(values);
        this.intervalMs = settings.intervalMs;
        this.batchSize = settings.batchSize;
        this.uploadWaitMs = settings.uploadWaitMs;
        this.uploadRetryMs = settings.uploadRetryMs;
        this.failureRetryMs = settings.failureRetryMs;
        this.maxRetries = settings.maxRetries;
        this.multiplier = settings.multiplier;
    }

    retryDelay(retryCount: number): number | undefined {
        if (retryCount >= this.maxRetries) return undefined;
        // Keep exponential delays within the range supported by JavaScript timers.
        return Math.min(
            2_147_483_647,
            this.uploadRetryMs * this.multiplier ** retryCount,
        );
    }
}
