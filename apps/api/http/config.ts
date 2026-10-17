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
//
import { z } from "zod";
import { publicUrl } from "../lib/url";

export type HttpSettings = z.input<typeof HttpConfiguration.schema>;

export class HttpConfiguration {
    static readonly schema = z.strictObject({
        maxBodyBytes: z
            .int()
            .positive()
            .default(64 * 1024),
        allowedOrigins: z
            .array(
                publicUrl.refine(
                    (value) =>
                        URL.canParse(value) && new URL(value).origin === value,
                ),
            )
            .default([]),
    });
    readonly maxBodyBytes: number;
    readonly allowedOrigins: ReadonlySet<string>;

    constructor(values: HttpSettings = {}) {
        const settings = HttpConfiguration.schema.parse(values);
        this.maxBodyBytes = settings.maxBodyBytes;
        this.allowedOrigins = new Set(settings.allowedOrigins);
    }
}
