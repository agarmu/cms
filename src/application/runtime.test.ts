import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { DatabaseSchema as schema } from "../db/schema";
import { S3Storage } from "../services/s3-storage";
import { ApplicationConfig } from "./config";
import { ApplicationRuntime } from "./runtime";

const databaseUrl = "postgres://localhost/cms_test";

test("runtime serves requests on an allocated port, shares lazy storage, and closes once", async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema: schema.definition });
    let runtime: ApplicationRuntime | undefined;
    let storageInitializations = 0;
    let closes = 0;
    const errors: Error[] = [];
    try {
        await migrate(db, {
            migrationsFolder: fileURLToPath(
                new URL("../../migrations/", import.meta.url),
            ),
        });
        runtime = await new ApplicationRuntime(
            new ApplicationConfig({
                database: { url: databaseUrl },
                port: 0,
                storage: { backend: "local", directory: "./data/blobs" },
            }),
            {
                connect: async (url) => {
                    expect(url).toMatchObject({
                        url: databaseUrl,
                        password: "",
                        max: 10,
                        connectionTimeout: 10,
                        idleTimeout: 30,
                        tls: "disable",
                    });
                    return {
                        db,
                        close: async () => {
                            closes++;
                            await client.close();
                        },
                    };
                },
                getBlobStorage: () => {
                    storageInitializations++;
                    return new S3Storage(
                        new Bun.S3Client({
                            bucket: "test",
                            region: "us-east-1",
                            accessKeyId: "test",
                            secretAccessKey: "test",
                        }),
                    );
                },
                reportError: (error) => errors.push(error),
            },
        ).start();
        expect(Number(runtime.url.port)).toBeGreaterThan(0);
        expect(storageInitializations).toBe(0);
        const created = await fetch(new URL("/images", runtime.url), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                taken: "2026-10-02T12:00:00Z",
                posted: "2026-10-02T13:00:00Z",
                alt: "Photo",
                description: "",
                enabled: true,
            }),
        });
        expect(created.status).toBe(201);
        const photo = (await created.json()) as { id: string };
        expect(storageInitializations).toBe(0);
        for (let attempt = 0; attempt < 2; attempt++) {
            const uploaded = await fetch(
                new URL(`/images/${photo.id}/upload`, runtime.url),
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ contentType: "image/png" }),
                },
            );
            expect(uploaded.status).toBe(201);
            expect(await uploaded.json()).toMatchObject({ method: "PUT" });
        }
        expect(storageInitializations).toBe(1);
        const stopping = runtime.stop();
        expect(runtime.stop()).toBe(stopping);
        await stopping;
        expect(closes).toBe(1);
        expect(errors).toEqual([]);
    } finally {
        if (runtime) await runtime.stop();
        else await client.close();
    }
}, 30_000);

test("runtime closes its database when the HTTP listener cannot start", async () => {
    const occupied = Bun.serve({
        port: 0,
        fetch: () => new Response("occupied"),
    });
    const client = new PGlite();
    const db = drizzle(client, { schema: schema.definition });
    let closes = 0;
    try {
        await expect(
            new ApplicationRuntime(
                new ApplicationConfig({
                    database: { url: databaseUrl },
                    storage: { backend: "local", directory: "./data/blobs" },
                    port: occupied.port!,
                }),
                {
                    connect: async () => ({
                        db,
                        close: async () => {
                            closes++;
                            await client.close();
                        },
                    }),
                    getBlobStorage: () => {
                        throw new Error("Startup must not initialize storage");
                    },
                },
            ).start(),
        ).rejects.toMatchObject({ code: "EADDRINUSE" });
        expect(closes).toBe(1);
    } finally {
        await occupied.stop(true);
        if (!closes) await client.close();
    }
}, 30_000);

test("stopping during startup waits for the connection and closes resources once", async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema: schema.definition });
    const connecting = Promise.withResolvers<void>();
    let closes = 0;
    const runtime = new ApplicationRuntime(
        new ApplicationConfig({
            database: { url: databaseUrl },
            storage: { backend: "local", directory: "./data/blobs" },
            port: 0,
        }),
        {
            connect: async () => {
                await connecting.promise;
                return {
                    db,
                    close: async () => {
                        closes++;
                        await client.close();
                    },
                };
            },
        },
    );
    try {
        const starting = runtime.start();
        expect(runtime.start()).toBe(starting);
        const stopping = runtime.stop();
        expect(runtime.stop()).toBe(stopping);
        expect(closes).toBe(0);
        connecting.resolve();
        await starting;
        await stopping;
        expect(closes).toBe(1);
        await expect(fetch(runtime.url)).rejects.toThrow();
        await expect(runtime.start()).rejects.toThrow(
            "Application has stopped",
        );
    } finally {
        connecting.resolve();
        await runtime.stop();
    }
}, 30_000);
