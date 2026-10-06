import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
        try {
            const configPath = join(directory, "config.toml");
            const secretsPath = join(directory, "secrets.toml");
            const signals = ["traces", "metrics", "logs"] as const;
            await Bun.write(
                configPath,
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
            // OTel globals are process-wide: exercise real startup in an isolated process.
            const script = [
                'import { ApplicationConfig } from "./src/application/config";',
                'import { Telemetry } from "./src/telemetry/setup";',
                'import { Tracing } from "./src/telemetry/tracing";',
                "const config = await ApplicationConfig.fromFiles(" +
                    JSON.stringify(configPath) +
                    ", " +
                    JSON.stringify(secretsPath) +
                    ");",
                "const telemetry = new Telemetry(config.telemetry);",
                "try {",
                "  telemetry.start();",
                "  telemetry.start();",
                '  if (process.env.OTEL_SERVICE_NAME !== "wrong-service") throw new Error("Environment was not restored");',
                '  const { HttpApplication } = await import("./src/http/app");',
                '  const app = new HttpApplication({ db: { select() { throw new Error("unused"); }, query: {} }, reportError: () => {}, getImageStorage: () => { throw new Error("unused"); } });',
                '  await app.request("/missing");',
                '  await Tracing.withSpan("file-config-span", async () => {});',
                '  telemetry.log("file-config-log");',
                "  await telemetry.forceFlush();",
                '  telemetry.log("shutdown-log");',
                "} finally { await telemetry.stop(); }",
            ].join("\n");
            const child = Bun.spawn([process.execPath, "--eval", script], {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    OTEL_EXPORTER_OTLP_HEADERS:
                        "x-environment-secret=must-not-export",
                    OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=wrong",
                    OTEL_EXPORTER_OTLP_METRICS_HEADERS: "authorization=wrong",
                    OTEL_EXPORTER_OTLP_LOGS_HEADERS: "authorization=wrong",
                    OTEL_SERVICE_NAME: "wrong-service",
                    OTEL_RESOURCE_ATTRIBUTES: "service.name=wrong-service",
                    OTEL_TRACES_SAMPLER: "always_off",
                    OTEL_SDK_DISABLED: "true",
                },
                stdout: "ignore",
                stderr: "pipe",
            });
            const [exitCode, stderr] = await Promise.all([
                child.exited,
                new Response(child.stderr).text(),
            ]);
            expect(stderr).toBe("");
            expect(exitCode).toBe(0);
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
            await collector.stop(true);
            await rm(directory, { recursive: true, force: true });
        }
    },
    20_000,
);
