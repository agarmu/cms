import { z } from "zod";

export type HttpSettings = z.input<typeof HttpConfiguration.schema>;

export class HttpConfiguration {
    static readonly schema = z.strictObject({
        maxBodyBytes: z
            .int()
            .positive()
            .default(64 * 1024),
    });
    readonly maxBodyBytes: number;

    constructor(values: HttpSettings = {}) {
        this.maxBodyBytes = HttpConfiguration.schema.parse(values).maxBodyBytes;
    }
}
