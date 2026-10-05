import { z } from "zod";
import { withSyncSpan } from "../telemetry/tracing";

const config = z.object({
    databaseUrl: z.url({ protocol: /^postgres(ql)?$/ }),
    // Zero lets the OS allocate a free port, including for integration tests.
    port: z.coerce.number().int().min(0).max(65535).default(3000),
});

export type ApplicationConfig = z.infer<typeof config>;

export function readConfig(
    env: Record<string, string | undefined> = process.env,
): ApplicationConfig {
    return withSyncSpan("application.config", () =>
        config.parse({ databaseUrl: env["DATABASE_URL"], port: env["PORT"] }),
    );
}
