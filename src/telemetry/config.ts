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

const signal = z
    .strictObject({
        enabled: z.boolean().default(false),
        endpoint: z
            .url({ protocol: /^https?$/ })
            .refine((value) => {
                const url = new URL(value);
                return (
                    !url.username && !url.password && !url.search && !url.hash
                );
            }, "Keep credentials in secrets.toml")
            .optional(),
    })
    .refine(
        (value) => !value.enabled || value.endpoint !== undefined,
        "Enabled signals require an endpoint",
    );
const signalSecrets = z.strictObject({
    headers: z
        .record(
            z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
            z.string().regex(/^[\t\x20-\x7e]*$/),
        )
        .default({}),
});
export type TelemetrySignal = z.output<typeof signal> & {
    headers: Record<string, string>;
};

export class TelemetryConfiguration {
    static readonly schema = z.strictObject({
        enabled: z.boolean().default(true),
        serviceName: z.string().min(1).default("photos-cms"),
        traces: signal.prefault({}),
        metrics: signal.prefault({}),
        logs: signal.prefault({}),
    });
    static readonly secretsSchema = z.strictObject({
        traces: signalSecrets.prefault({}),
        metrics: signalSecrets.prefault({}),
        logs: signalSecrets.prefault({}),
    });

    readonly enabled: boolean;
    readonly serviceName: string;
    readonly traces: TelemetrySignal;
    readonly metrics: TelemetrySignal;
    readonly logs: TelemetrySignal;

    constructor(
        values: z.input<typeof TelemetryConfiguration.schema> = {},
        secrets: z.input<typeof TelemetryConfiguration.secretsSchema> = {},
    ) {
        const settings = TelemetryConfiguration.schema.parse(values);
        const credentials = TelemetryConfiguration.secretsSchema.parse(secrets);
        this.enabled = settings.enabled;
        this.serviceName = settings.serviceName;
        this.traces = { ...settings.traces, ...credentials.traces };
        this.metrics = { ...settings.metrics, ...credentials.metrics };
        this.logs = { ...settings.logs, ...credentials.logs };
    }
}
