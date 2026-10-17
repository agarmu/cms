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
                    name: z
                        .string()
                        .regex(/^[a-zA-Z0-9_-]+$/)
                        .refine((name) => name.toLowerCase() !== "original", {
                            message:
                                "original is reserved for the full-resolution image",
                        }),
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
