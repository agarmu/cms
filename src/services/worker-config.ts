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

import { z } from "zod";

export type WorkerSettings = z.input<typeof WorkerConfiguration.schema>;

export class WorkerConfiguration {
    static readonly schema = z.strictObject({
        interval: z.int().positive().max(2_147_483_647).default(5000),
        batchSize: z.int().positive().default(10),
        backoff: z
            .strictObject({
                maxRetries: z.int().nonnegative().default(5),
                multiplier: z.number().finite().gt(1).default(2),
            })
            .prefault({}),
        upload: z
            .strictObject({
                waitTime: z.int().positive().default(3_600_000),
                retryTime: z
                    .int()
                    .positive()
                    .max(2_147_483_647)
                    .default(10_000),
            })
            .prefault({}),
    });

    readonly interval: number;
    readonly batchSize: number;
    readonly backoff: z.output<typeof WorkerConfiguration.schema>["backoff"];
    readonly upload: z.output<typeof WorkerConfiguration.schema>["upload"];

    constructor(values: WorkerSettings = {}) {
        const settings = WorkerConfiguration.schema.parse(values);
        this.interval = settings.interval;
        this.batchSize = settings.batchSize;
        this.backoff = settings.backoff;
        this.upload = settings.upload;
    }

    retryDelay(retryCount: number): number | undefined {
        if (retryCount >= this.backoff.maxRetries) return undefined;
        return Math.min(
            2_147_483_647,
            this.upload.retryTime * this.backoff.multiplier ** retryCount,
        );
    }
}
