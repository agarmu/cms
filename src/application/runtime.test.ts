import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../db/schema";
import { S3Storage } from "../services/s3-storage";
import { readConfig } from "./config";
import { startApplication } from "./runtime";

const databaseUrl = "postgres://localhost/cms_test";

test("runtime serves requests on an allocated port, shares lazy storage, and closes once", async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    let runtime: Awaited<ReturnType<typeof startApplication>> | undefined;
    let storageInitializations = 0;
    let closes = 0;
    const errors: Error[] = [];
    try {
        await migrate(db, {
            migrationsFolder: fileURLToPath(
                new URL("../../migrations/", import.meta.url),
            ),
        });
        runtime = await startApplication(
            readConfig({ DATABASE_URL: databaseUrl, PORT: "0" }),
            {
                connect: async (url) => {
                    expect(url).toBe(databaseUrl);
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
        );
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
    const db = drizzle(client, { schema });
    let closes = 0;
    try {
        await expect(
            startApplication(
                { databaseUrl, port: occupied.port! },
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
            ),
        ).rejects.toMatchObject({ code: "EADDRINUSE" });
        expect(closes).toBe(1);
    } finally {
        await occupied.stop(true);
        if (!closes) await client.close();
    }
}, 30_000);
