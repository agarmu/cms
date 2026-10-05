import { z } from "zod";

export type HttpSettings = { maxBodyBytes?: number };

export class HttpConfiguration {
    readonly maxBodyBytes: number;

    constructor(values: HttpSettings = {}) {
        this.maxBodyBytes = z
            .int()
            .positive()
            .parse(values.maxBodyBytes ?? 64 * 1024);
    }
}
