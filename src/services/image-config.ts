import { z } from "zod";

export type ImageSettings = {
    maxBytes?: number;
    maxPixels?: number;
    quality?: number;
    variants?: { name: string; minSide: number }[];
};

export class ImageConfiguration {
    get mcpMaxBodyBytes() {
        return Math.ceil(this.maxBytes / 3) * 4 + 65_536;
    }
    static readonly schema = z.strictObject({
        maxBytes: z
            .int()
            .positive()
            .default(25 * 1024 * 1024),
        maxPixels: z.int().positive().default(60_000_000),
        quality: z.int().min(1).max(100).default(82),
        variants: z
            .array(
                z.strictObject({
                    name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
                    minSide: z.int().positive(),
                }),
            )
            .default([
                { name: "large", minSide: 1920 },
                { name: "medium", minSide: 960 },
                { name: "thumbnail", minSide: 320 },
            ]),
    });

    readonly maxBytes: number;
    readonly maxPixels: number;
    readonly quality: number;
    readonly variants: ReadonlyArray<
        Readonly<{ name: string; minSide: number }>
    >;

    constructor(values: ImageSettings = {}) {
        const settings = ImageConfiguration.schema.parse(values);
        this.maxBytes = settings.maxBytes;
        this.maxPixels = settings.maxPixels;
        this.quality = settings.quality;
        this.variants = Object.freeze(
            settings.variants.map((variant) => Object.freeze(variant)),
        );
    }
}
