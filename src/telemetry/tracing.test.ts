import { readyUpload } from "../api/test-fixtures";
import { requestAsUser, testAuthIdentity } from "../auth/test-fixtures";
import { testAuthSettings, testAuthDependencies } from "../auth/test-fixtures";
import { StorageConfiguration } from "../services/storage-config";
import { WorkerConfiguration } from "../services/worker-config";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import sharp from "sharp";
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
import { DatabaseSchema as schema } from "../db/schema";
import { Application } from "../application";
import { ApplicationConfig } from "../application/config";
import { ApplicationRuntime } from "../application/runtime";
import { StorageFactory } from "../application/storage";
import { PhotoApi } from "../api/photos";
import { ImageUploadApi } from "../api/image-uploads";
import { ImageStorage } from "../services/image-storage";
import { LocalStorage } from "../services/local-storage";
import { S3Storage } from "../services/s3-storage";
import type { S3Client } from "../services/s3-storage";
import { BackgroundWorker } from "../services/background-worker";
import { ImageUploadWorker } from "../services/image-upload-worker";
import { ImageGarbageCollector } from "../services/image-garbage-collector";
import { Telemetry } from "./setup";
import { Tracing } from "./tracing";

const exporter = new InMemorySpanExporter();
const telemetry = new Telemetry();
const client = new PGlite();
const db = drizzle(client, { schema: schema.definition });
const { http: app } = new Application({
    ...testAuthDependencies,
    db,
    getBlobStorage: () => {
        throw new Error("Metadata requests must not initialize blob storage");
    },
    reportError: () => {},
});
let provider: NonNullable<ReturnType<Telemetry["start"]>>;
const metadata = {
    taken: "2026-10-02T12:00:00.000Z",
    posted: "2026-10-02T13:00:00.000Z",
    alt: "Photo",
    description: "",
    enabled: true,
};

beforeAll(async () => {
    provider = telemetry.start(exporter)!;
    await migrate(db, {
        migrationsFolder: fileURLToPath(
            new URL("../../migrations/", import.meta.url),
        ),
    });
}, 30_000);
afterAll(async () => {
    await client.close();
    await telemetry.stop();
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
    const response = await requestAsUser(app, "/api/photos", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            traceparent: `00-${incomingTrace}-${incomingSpan}-01`,
        },
        body: JSON.stringify({
            ...metadata,
            uploadId: await readyUpload(db),
            camera: { create: { name: "Camera" } },
        }),
    });
    expect(response.status).toBe(201);
    const spans = await spansFor(incomingTrace);
    const server = spans.find((span) => span.kind === SpanKind.SERVER)!;
    expect(server.parentSpanContext?.spanId).toBe(incomingSpan);
    expect(server.attributes["http.route"]).toBe("/api/photos");
    expect(server.attributes["http.response.status_code"]).toBe(201);
    const create = spans.find((span) => span.name === "photo.create")!;
    const transaction = spans.find(
        (span) => span.name === "photo.transaction",
    )!;
    const camera = spans.find((span) => span.name === "cameras.create")!;
    const assets = spans.find((span) => span.name === "photo.assets.replace")!;
    const asset = spans.find((span) => span.name === "image-assets.create")!;
    expect(create.parentSpanContext?.spanId).toBe(
        spans
            .find((span) => span.name === "photo.createFromUpload")!
            .spanContext().spanId,
    );
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
    const response = await requestAsUser(app, "/api/photos", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            traceparent: `00-${traceId}-${incomingSpan}-01`,
        },
        body: JSON.stringify({
            ...metadata,
            uploadId: await readyUpload(db),
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
    await Tracing.withSpan("parallel.parent", async () => {
        traceId = trace.getActiveSpan()!.spanContext().traceId;
        await Promise.all(
            ["first", "second"].map((name) =>
                Tracing.withSpan(name, async () => {
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
    const response = await requestAsUser(app, "/api/photos", {
        headers: { traceparent: `00-${traceId}-${incomingSpan}-00` },
    });
    expect(response.status).toBe(200);
    expect(await spansFor(traceId)).toEqual([]);
});

test("upload processing and GC retain nested storage spans and handled retry failures", async () => {
    const objects = new Map<string, Uint8Array>();
    const failure = new Error("Temporary deletion failure");
    let failDeletion = true;
    const s3: S3Client = {
        presign: () =>
            "https://storage.example/signed?signature=secret-signature",
        file: (key) => ({
            exists: async () => objects.has(key),
            stat: async () => ({
                size: objects.get(key)!.length,
                lastModified: new Date(),
                etag: "test",
                type: "image/png",
            }),
            stream: () => new Blob([objects.get(key)!]).stream(),
        }),
        write: async (key, data) => {
            const bytes = new Uint8Array(
                await new Response(
                    data as NonNullable<RequestInit["body"]>,
                ).arrayBuffer(),
            );
            objects.set(key, bytes);
            return bytes.length;
        },
        delete: async (key) => {
            if (failDeletion) throw failure;
            objects.delete(key);
        },
    };
    const storage = new ImageStorage(new S3Storage(s3));
    const errors: Error[] = [];
    const options = {
        db,
        getStorage: () => storage,
        reportError: (error: Error) => errors.push(error),
    };
    const original = await sharp({
        create: { width: 640, height: 320, channels: 3, background: "red" },
    })
        .png()
        .toBuffer();
    let traceId = "";
    await Tracing.withSpan("test.image.pipeline", async () => {
        traceId = trace.getActiveSpan()!.spanContext().traceId;
        const photo = await PhotoApi.create(db, {
            ...metadata,
            taken: new Date(metadata.taken),
            posted: new Date(metadata.posted),
        });
        const upload = await ImageUploadApi.replace(
            db,
            storage,
            photo.id,
            "image/png",
            testAuthIdentity,
        );
        objects.set(`originals/${photo.id}/${upload.id}`, original);
        await db
            .update(schema.imageUploads)
            .set({ nextCheck: new Date(0) })
            .where(eq(schema.imageUploads.photoId, photo.id));
        await new ImageUploadWorker(options).check();
        const saved = await PhotoApi.read(db, photo.id);
        expect(saved.assets).toHaveLength(1);
        await storage.read(photo.id, saved.assets[0]!.assetLocation);
        await PhotoApi.update(db, photo.id, { assets: [] });
        const due = () =>
            db
                .update(schema.imageAssetGarbage)
                .set({ nextCheck: new Date(0) })
                .where(eq(schema.imageAssetGarbage.photoId, photo.id));
        await due();
        await new ImageGarbageCollector(options).collect();
        failDeletion = false;
        await due();
        await new ImageGarbageCollector(options).collect();
    });
    expect(errors).toEqual([failure]);
    const spans = await spansFor(traceId);
    const span = (name: string) => {
        const found = spans.find((candidate) => candidate.name === name);
        expect(found).toBeDefined();
        return found!;
    };
    for (const [child, parent] of [
        ["image.upload.job", "image.upload.check"],
        ["image.upload.complete", "image.upload.job"],
        ["image.storage.process", "image.upload.complete"],
        ["storage.s3.get", "image.storage.process"],
        ["storage.s3.download", "image.storage.process"],
        ["image.prepare", "image.storage.publish"],
        ["image.metadata", "image.prepare"],
        ["image.convert", "image.prepare"],
        ["storage.s3.write", "image.storage.publish"],
        ["photo.transaction", "photo.create"],
        ["storage.s3.upload.sign", "image.storage.upload.create"],
        ["storage.s3.download.sign", "image.storage.read"],
        ["storage.s3.delete", "image.storage.delete"],
    ]) {
        expect(span(child!).parentSpanContext?.spanId).toBe(
            span(parent!).spanContext().spanId,
        );
    }
    expect(span("image.upload.publish").parentSpanContext?.spanId).toBe(
        span("image.upload.complete").spanContext().spanId,
    );
    expect(span("image.upload.job").attributes["job.outcome"]).toBe(
        "completed",
    );
    expect(
        span("storage.s3.download").attributes["storage.transfer.bytes"],
    ).toBe(original.length);
    expect(span("storage.s3.write").kind).toBe(SpanKind.CLIENT);
    expect(span("image.convert").attributes["image.variant"]).toBe("thumbnail");
    const jobs = spans.filter(
        (candidate) => candidate.name === "image.garbage.asset",
    );
    expect(jobs.map((job) => job.attributes["job.outcome"])).toEqual([
        "retry",
        "deleted",
    ]);
    expect(jobs[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(jobs[0]!.events.some((event) => event.name === "exception")).toBe(
        true,
    );
    const exported = JSON.stringify(
        spans.map(({ attributes, events }) => ({ attributes, events })),
    );
    expect(exported).not.toContain("secret-signature");
});

test("local image transfers, conversion, and cleanup are traced", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cms-traces-"));
    let traceId = "";
    try {
        await Tracing.withSpan("test.local.pipeline", async () => {
            traceId = trace.getActiveSpan()!.spanContext().traceId;
            const blobs = new StorageFactory(
                new StorageConfiguration({ backend: "local", directory }),
            ).create();
            expect(blobs).toBeInstanceOf(LocalStorage);
            const storage = new ImageStorage(blobs);
            const photoId = crypto.randomUUID();
            const uploadId = crypto.randomUUID();
            const original = await sharp({
                create: {
                    width: 320,
                    height: 320,
                    channels: 3,
                    background: "blue",
                },
            })
                .png()
                .toBuffer();
            await blobs.write(
                `originals/${photoId}/${uploadId}`,
                original,
                "image/png",
            );
            const processed = await storage.processUpload(photoId, uploadId);
            expect(
                await storage.read(photoId, processed.assets[0]!.assetLocation),
            ).toBeDefined();
            await processed.cleanup();
        });
        const spans = await spansFor(traceId);
        for (const name of [
            "storage.initialize",
            "storage.local.write",
            "storage.local.get",
            "storage.local.download",
            "storage.local.read",
            "storage.local.delete",
            "image.storage.cleanup",
        ]) {
            expect(spans.some((span) => span.name === name)).toBe(true);
        }
        expect(
            spans.every((span) => span.status.code !== SpanStatusCode.ERROR),
        ).toBe(true);
        const cleanup = spans.find(
            (span) => span.name === "image.storage.cleanup",
        )!;
        const deleted = spans.find(
            (span) => span.name === "storage.local.delete",
        )!;
        expect(deleted.parentSpanContext?.spanId).toBe(
            cleanup.spanContext().spanId,
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("stream spans finish on read failure and cancellation of a pending read", async () => {
    const failure = new Error("Stream read failed");
    let traceId = "";
    let cancelled = false;
    await Tracing.withSpan("test.streams", async () => {
        traceId = trace.getActiveSpan()!.spanContext().traceId;
        const broken = Tracing.tracedStream(
            "test.stream.failed",
            () =>
                new ReadableStream({
                    pull() {
                        throw failure;
                    },
                }),
        );
        await expect(new Response(broken).arrayBuffer()).rejects.toBe(failure);
        const waiting = Tracing.tracedStream(
            "test.stream.cancelled",
            () =>
                new ReadableStream({
                    cancel() {
                        cancelled = true;
                    },
                }),
        );
        const reader = waiting.getReader();
        const reading = reader.read();
        await reader.cancel();
        expect(await reading).toEqual({ done: true, value: undefined });
        reader.releaseLock();
    });
    expect(cancelled).toBe(true);
    const spans = await spansFor(traceId);
    const failed = spans.find((span) => span.name === "test.stream.failed")!;
    expect(failed.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed.events.some((event) => event.name === "exception")).toBe(
        true,
    );
    const stopped = spans.filter(
        (span) => span.name === "test.stream.cancelled",
    );
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.attributes["storage.transfer.cancelled"]).toBe(true);
    expect(stopped[0]!.status.code).not.toBe(SpanStatusCode.ERROR);
});

test("worker cycles use independent root traces and record handled task failures", async () => {
    const secondCycle = Promise.withResolvers<void>();
    const errors: Error[] = [];
    const cycleIds: string[] = [];
    const failure = new Error("Task failed");
    let startupId = "";
    const worker = await Tracing.withSpan("test.worker.startup", async () => {
        startupId = trace.getActiveSpan()!.spanContext().traceId;
        return new BackgroundWorker(
            {
                tasks: [
                    () =>
                        Tracing.withSpan("test.worker.task", async () => {
                            cycleIds.push(
                                trace.getActiveSpan()!.spanContext().traceId,
                            );
                            if (cycleIds.length === 2) secondCycle.resolve();
                            throw failure;
                        }),
                ],
                reportError: (error) => errors.push(error),
            },
            new WorkerConfiguration({ interval: 1 }),
        ).start();
    });
    try {
        await secondCycle.promise;
    } finally {
        await worker.stop();
    }
    expect(errors).toEqual([failure, failure]);
    expect(new Set([startupId, ...cycleIds]).size).toBe(3);
    for (const id of cycleIds) {
        const spans = await spansFor(id);
        const cycle = spans.find((span) => span.name === "worker.cycle")!;
        const task = spans.find((span) => span.name === "test.worker.task")!;
        expect(cycle.parentSpanContext).toBeUndefined();
        expect(cycle.status.code).toBe(SpanStatusCode.ERROR);
        expect(task.parentSpanContext?.spanId).toBe(cycle.spanContext().spanId);
    }
});

test("application configuration, assembly, startup, and shutdown emit spans", async () => {
    let traceId = "";
    await Tracing.withSpan("test.lifecycle", async () => {
        traceId = trace.getActiveSpan()!.spanContext().traceId;
        new StorageFactory(
            new StorageConfiguration({
                backend: "local",
                directory: "./data/blobs",
            }),
        ).create();
        const config = new ApplicationConfig({
            auth: testAuthSettings,
            database: { url: "postgres://localhost/test" },
            port: 0,
            storage: { backend: "local", directory: "./data/blobs" },
        });
        const application = await new ApplicationRuntime(config, {
            connect: async () => ({ db, close: async () => {} }),
            getBlobStorage: () => {
                throw new Error("Storage should remain lazy");
            },
        }).start();
        await application.stop();
    });
    const spans = await spansFor(traceId);
    for (const name of [
        "application.config",
        "runtime.startup",
        "application.initialize",
        "http.app.initialize",
        "http.server.start",
        "application.start",
        "worker.start",
        "runtime.shutdown",
        "http.server.stop",
        "application.stop",
        "worker.stop",
    ]) {
        expect(spans.some((span) => span.name === name)).toBe(true);
    }
    expect(spans.some((span) => span.name === "storage.initialize")).toBe(true);
    const shutdown = spans.find((span) => span.name === "runtime.shutdown")!;
    const applicationStop = spans.find(
        (span) => span.name === "application.stop",
    )!;
    expect(applicationStop.parentSpanContext?.spanId).toBe(
        shutdown.spanContext().spanId,
    );
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
