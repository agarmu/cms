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

const endpoint = z.url({ protocol: /^https?$/ }).refine((value) => {
    const url = new URL(value);
    return (
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/"
    );
}, "Use a bucket endpoint without credentials, query parameters, or a path");

export type StorageSettings = z.input<typeof StorageConfiguration.schema>;

export class StorageConfiguration {
    static readonly schema = z.discriminatedUnion("backend", [
        z.strictObject({
            backend: z.literal("local"),
            directory: z.string().min(1),
        }),
        z.strictObject({
            backend: z.literal("s3"),
            endpoint,
            region: z.string().min(1).optional(),
        }),
    ]);
    static readonly secretsSchema = z.strictObject({
        accessKeyId: z.string().min(1).optional(),
        secretAccessKey: z.string().min(1).optional(),
        sessionToken: z.string().min(1).optional(),
    });

    readonly backend: "s3" | "local";
    readonly directory: string | undefined;
    private readonly options: Bun.S3Options | undefined;

    constructor(
        values: StorageSettings,
        secrets: z.input<typeof StorageConfiguration.secretsSchema> = {},
    ) {
        const settings = StorageConfiguration.schema.parse(values);
        const credentials = StorageConfiguration.secretsSchema.parse(secrets);
        this.backend = settings.backend;
        this.directory =
            settings.backend === "local" ? settings.directory : undefined;
        if (settings.backend === "s3") {
            if (!credentials.accessKeyId || !credentials.secretAccessKey)
                throw new Error(
                    "S3 requires accessKeyId and secretAccessKey in secrets.toml",
                );
            const hostname = new URL(settings.endpoint).hostname;
            const region =
                settings.region ??
                hostname.match(
                    /\.s3[.-](?:dualstack\.)?([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com(?:\.cn)?$/,
                )?.[1] ??
                "us-east-1";
            this.options = {
                endpoint: settings.endpoint,
                region,
                virtualHostedStyle: true,
                bucket: "",
                accessKeyId: credentials.accessKeyId,
                secretAccessKey: credentials.secretAccessKey,
                ...(credentials.sessionToken
                    ? { sessionToken: credentials.sessionToken }
                    : {}),
            };
        }
    }

    clientOptions(): Bun.S3Options {
        if (!this.options)
            throw new Error("S3 options are unavailable for local storage");
        return { ...this.options };
    }
}
