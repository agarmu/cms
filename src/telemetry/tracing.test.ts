import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
    context,
    propagation,
    SpanKind,
    SpanStatusCode,
    trace,
} from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { z } from "zod";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../db/schema";
import { createApp } from "../http/app";
import { startTelemetry } from "./setup";
import { withSpan } from "./tracing";

const exporter = new InMemorySpanExporter();
const client = new PGlite();
const db = drizzle(client, { schema });
const app = createApp({ db, reportError: () => {} });
let provider: NonNullable<ReturnType<typeof startTelemetry>>;
const metadata = {
    taken: "2026-10-02T12:00:00.000Z",
    posted: "2026-10-02T13:00:00.000Z",
    alt: "Photo",
    description: "",
    enabled: true,
};

beforeAll(async () => {
    provider = startTelemetry(exporter)!;
    await migrate(db, {
        migrationsFolder: fileURLToPath(
            new URL("../../migrations/", import.meta.url),
        ),
    });
}, 30_000);
afterAll(async () => {
    await client.close();
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
});

async function spansFor(traceId: string) {
    await provider.forceFlush();
    return exporter
        .getFinishedSpans()
        .filter((span) => span.spanContext().traceId === traceId);
}

const incomingTrace = "11111111111111111111111111111111";
const incomingSpan = "2222222222222222";

test("Bun propagates incoming W3C context through HTTP, transactions, and API spans", async () => {
    const response = await app.request("/images", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            traceparent: `00-${incomingTrace}-${incomingSpan}-01`,
        },
        body: JSON.stringify({
            ...metadata,
            camera: { create: { name: "Camera" } },
            assets: [{ width: 100, height: 100, assetLocation: "photo.webp" }],
        }),
    });
    expect(response.status).toBe(201);
    const spans = await spansFor(incomingTrace);
    const server = spans.find((span) => span.kind === SpanKind.SERVER)!;
    expect(server.parentSpanContext?.spanId).toBe(incomingSpan);
    expect(server.attributes["http.route"]).toBe("/images");
    expect(server.attributes["http.response.status_code"]).toBe(201);
    const create = spans.find((span) => span.name === "photo.create")!;
    const transaction = spans.find(
        (span) => span.name === "photo.transaction",
    )!;
    const camera = spans.find((span) => span.name === "cameras.create")!;
    const assets = spans.find((span) => span.name === "photo.assets.replace")!;
    const asset = spans.find((span) => span.name === "image-assets.create")!;
    expect(create.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
    expect(transaction.parentSpanContext?.spanId).toBe(
        create.spanContext().spanId,
    );
    expect(camera.parentSpanContext?.spanId).toBe(
        transaction.spanContext().spanId,
    );
    expect(assets.parentSpanContext?.spanId).toBe(
        transaction.spanContext().spanId,
    );
    expect(asset.parentSpanContext?.spanId).toBe(assets.spanContext().spanId);
    expect(assets.attributes["photo.assets.count"]).toBe(1);
});

test("handled API errors still mark and finish the HTTP and child spans", async () => {
    const traceId = "33333333333333333333333333333333";
    const response = await app.request("/images", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            traceparent: `00-${traceId}-${incomingSpan}-01`,
        },
        body: JSON.stringify({
            ...metadata,
            camera: { id: crypto.randomUUID() },
        }),
    });
    expect(response.status).toBe(409);
    const spans = await spansFor(traceId);
    const server = spans.find((span) => span.kind === SpanKind.SERVER)!;
    expect(server.attributes["http.response.status_code"]).toBe(409);
    expect(server.status.code).toBe(SpanStatusCode.ERROR);
    const transaction = spans.find(
        (span) => span.name === "photo.transaction",
    )!;
    expect(transaction.status.code).toBe(SpanStatusCode.ERROR);
    expect(transaction.attributes["error.type"]).toBe("conflict");
    expect(transaction.events.some((event) => event.name === "exception")).toBe(
        true,
    );
});

test("parallel asynchronous operations keep separate active child spans", async () => {
    let traceId = "";
    await withSpan("parallel.parent", async () => {
        traceId = trace.getActiveSpan()!.spanContext().traceId;
        await Promise.all(
            ["first", "second"].map((name) =>
                withSpan(name, async () => {
                    const spanId = trace.getActiveSpan()!.spanContext().spanId;
                    await Bun.sleep(5);
                    expect(trace.getActiveSpan()!.spanContext().spanId).toBe(
                        spanId,
                    );
                }),
            ),
        );
    });
    const spans = await spansFor(traceId);
    const parent = spans.find((span) => span.name === "parallel.parent")!;
    const children = spans.filter((span) => span.name !== "parallel.parent");
    expect(children).toHaveLength(2);
    for (const child of children)
        expect(child.parentSpanContext?.spanId).toBe(
            parent.spanContext().spanId,
        );
});

test("unsampled incoming traces do not export child spans", async () => {
    const traceId = "44444444444444444444444444444444";
    const response = await app.request("/images", {
        headers: { traceparent: `00-${traceId}-${incomingSpan}-00` },
    });
    expect(response.status).toBe(200);
    expect(await spansFor(traceId)).toEqual([]);
});

test("exports standard OTLP HTTP JSON with configured authentication and nested span IDs", async () => {
    const received: { payload?: unknown; authentication?: string | null } = {};
    const collector = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
            received.authentication = request.headers.get("x-sentry-auth");
            received.payload = await request.json();
            return Response.json({});
        },
    });
    const previousEndpoint = process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"];
    const previousHeaders = process.env["OTEL_EXPORTER_OTLP_TRACES_HEADERS"];
    process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] = new URL(
        "/v1/traces",
        collector.url,
    ).href;
    process.env["OTEL_EXPORTER_OTLP_TRACES_HEADERS"] = "x-sentry-auth=test-key";
    const otlp = new OTLPTraceExporter();
    try {
        const spans = await spansFor(incomingTrace);
        await new Promise<void>((resolve, reject) =>
            otlp.export(spans, (result) => {
                if (result.code === 0) resolve();
                else reject(result.error ?? new Error("OTLP export failed"));
            }),
        );
        expect(received.authentication).toBe("test-key");
        const payload = z
            .object({
                resourceSpans: z.array(
                    z.object({
                        resource: z.object({
                            attributes: z.array(
                                z.object({
                                    key: z.string(),
                                    value: z
                                        .object({ stringValue: z.string() })
                                        .passthrough(),
                                }),
                            ),
                        }),
                        scopeSpans: z.array(
                            z.object({
                                spans: z.array(
                                    z.object({
                                        name: z.string(),
                                        traceId: z.string(),
                                        spanId: z.string(),
                                        parentSpanId: z.string().optional(),
                                    }),
                                ),
                            }),
                        ),
                    }),
                ),
            })
            .parse(received.payload);
        const exported = payload.resourceSpans.flatMap((resource) =>
            resource.scopeSpans.flatMap((scope) => scope.spans),
        );
        const parent = exported.find((span) => span.name === "photo.create")!;
        const child = exported.find(
            (span) => span.name === "photo.transaction",
        )!;
        expect(parent.traceId).toBe(incomingTrace);
        expect(child.parentSpanId).toBe(parent.spanId);
        expect(payload.resourceSpans[0]?.resource.attributes).toContainEqual({
            key: "service.name",
            value: { stringValue: "photos-cms" },
        });
    } finally {
        if (previousEndpoint === undefined)
            delete process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"];
        else
            process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] =
                previousEndpoint;
        if (previousHeaders === undefined)
            delete process.env["OTEL_EXPORTER_OTLP_TRACES_HEADERS"];
        else process.env["OTEL_EXPORTER_OTLP_TRACES_HEADERS"] = previousHeaders;
        await otlp.shutdown();
        await collector.stop(true);
    }
});
