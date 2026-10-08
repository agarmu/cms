import { testAuthDependencies, testAuthToml } from "../auth/test-fixtures";
import { afterAll, afterEach, expect, test } from "bun:test";
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { DatabaseSchema } from "../db/schema";
import { ApplicationConfig } from "../application/config";
import { HttpApplication } from "../http/app";
import { Telemetry } from "./setup";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const client = new PGlite();
afterAll(() => client.close());

const environment = {
    OTEL_EXPORTER_OTLP_HEADERS: "x-environment-secret=must-not-export",
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=wrong",
    OTEL_EXPORTER_OTLP_METRICS_HEADERS: "authorization=wrong",
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: "authorization=wrong",
    OTEL_SERVICE_NAME: "wrong-service",
    OTEL_RESOURCE_ATTRIBUTES: "service.name=wrong-service",
    OTEL_TRACES_SAMPLER: "always_off",
    OTEL_SDK_DISABLED: "true",
};
const previousEnvironment = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
);
afterEach(() => {
    trace.disable();
    metrics.disable();
    context.disable();
    propagation.disable();
    for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

test.each([
    { traces: true, metrics: true, logs: true },
    { traces: false, metrics: true, logs: true },
    { traces: true, metrics: false, logs: false },
    { traces: false, metrics: true, logs: false },
    { traces: false, metrics: false, logs: true },
    { traces: false, metrics: false, logs: false },
    { traces: true, metrics: true, logs: true, disabled: true },
])(
    "exports only enabled signals with file headers and ignores environment credentials (%#)",
    async (enabled) => {
        const received: {
            path: string;
            authentication: string | null;
            leaked: string | null;
            payload: unknown;
        }[] = [];
        const collector = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: async (request) => {
                received.push({
                    path: new URL(request.url).pathname,
                    authentication: request.headers.get("authorization"),
                    leaked: request.headers.get("x-environment-secret"),
                    payload: await request.json(),
                });
                return Response.json({});
            },
        });
        const directory = await mkdtemp(join(tmpdir(), "cms-telemetry-"));
        let telemetry: Telemetry | undefined;
        try {
            const configPath = join(directory, "config.toml");
            const secretsPath = join(directory, "secrets.toml");
            const signals = ["traces", "metrics", "logs"] as const;
            await Bun.write(
                configPath,
                testAuthToml +
                    '[database]\nurl = "postgres://localhost/cms"\n[storage]\nbackend = "local"\ndirectory = "./data/blobs"\n[telemetry]\nserviceName = "file-service"\nenabled = ' +
                    !enabled.disabled +
                    "\n" +
                    signals
                        .map(
                            (signal) =>
                                "[telemetry." +
                                signal +
                                "]\nenabled = " +
                                enabled[signal] +
                                '\nendpoint = "' +
                                new URL("/v1/" + signal, collector.url).href +
                                '"\n',
                        )
                        .join(""),
            );
            await Bun.write(
                secretsPath,
                signals
                    .map(
                        (signal) =>
                            "[telemetry." +
                            signal +
                            '.headers]\nAuthorization = "Bearer file-' +
                            signal +
                            '"\n',
                    )
                    .join(""),
            );
            Object.assign(process.env, environment);
            const config = await ApplicationConfig.fromFiles(
                configPath,
                secretsPath,
            );
            telemetry = new Telemetry(config.telemetry);
            telemetry.start();
            telemetry.start();
            for (const [key, value] of Object.entries(environment)) {
                expect(process.env[key]).toBe(value);
            }
            const app = new HttpApplication({
                ...testAuthDependencies,
                db: drizzle(client, { schema: DatabaseSchema.definition }),
                reportError: (error) => {
                    throw error;
                },
                getImageStorage: () => {
                    throw new Error("unused");
                },
            });
            const response = await app.request("/missing", {
                headers: { Authorization: "Bearer test-token" },
            });
            expect(response.status).toBe(404);
            trace
                .getTracer("telemetry-integration")
                .startSpan("file-config-span")
                .end();
            telemetry.log("file-config-log");
            await telemetry.forceFlush();
            telemetry.log("shutdown-log");
            await telemetry.stop();
            for (const signal of signals) {
                const exports = received.filter(
                    (entry) => entry.path === "/v1/" + signal,
                );
                expect(exports.length > 0).toBe(
                    enabled[signal] && !enabled.disabled,
                );
                for (const entry of exports) {
                    expect(entry.authentication).toBe("Bearer file-" + signal);
                    expect(entry.leaked).toBeNull();
                    expect(JSON.stringify(entry.payload)).toContain(
                        "file-service",
                    );
                    expect(JSON.stringify(entry.payload)).not.toContain(
                        "wrong-service",
                    );
                }
            }
            if (enabled.metrics && !enabled.disabled)
                expect(JSON.stringify(received)).toContain(
                    "http.server.request.duration",
                );
            if (enabled.logs && !enabled.disabled)
                expect(JSON.stringify(received)).toContain("file-config-log");
            if (enabled.logs && !enabled.disabled)
                expect(JSON.stringify(received)).toContain("shutdown-log");
            if (enabled.traces && !enabled.disabled)
                expect(JSON.stringify(received)).toContain("file-config-span");
        } finally {
            try {
                await telemetry?.stop();
            } finally {
                await collector.stop(true);
                await rm(directory, { recursive: true, force: true });
            }
        }
    },
    20_000,
);
