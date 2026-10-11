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
import { NoAuthenticationProvider } from "../auth/no-auth";
import { readyUpload } from "../api/test-fixtures";
import {
    testAuthSettings,
    testAuthentication,
    testAuthIdentity,
} from "../auth/test-fixtures";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { DatabaseSchema as schema } from "../db/schema";
import { S3Storage } from "../services/s3-storage";
import { ApplicationConfig } from "./config";
import { ApplicationRuntime } from "./runtime";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const databaseUrl = "postgres://localhost/cms_test";

test.each([false, true])(
    "runtime serves and releases a Unix socket after crash=%s",
    async (crashed) => {
        const directory = await mkdtemp(join(tmpdir(), "cms-"));
        const unix = join(directory, "http.sock");
        const client = new PGlite();
        const db = drizzle(client, { schema: schema.definition });
        const config = new ApplicationConfig({
            auth: { kind: "no-auth" },
            database: { url: databaseUrl },
            storage: { backend: "local", directory: "./data/blobs" },
            serve: { unix },
        });
        let closes = 0;
        const runtime = new ApplicationRuntime(config, {
            connect: async () => ({
                db,
                close: async () => {
                    closes++;
                    await client.close();
                },
            }),
        });
        try {
            await migrate(db, {
                migrationsFolder: fileURLToPath(
                    new URL("../../migrations/", import.meta.url),
                ),
            });
            if (crashed) {
                const child = Bun.spawn(
                    [
                        process.execPath,
                        "-e",
                        `Bun.serve({ unix: ${JSON.stringify(unix)}, fetch: () => new Response("old") }); console.log("ready");`,
                    ],
                    { stdout: "pipe", stderr: "pipe" },
                );
                try {
                    const reader = child.stdout.getReader();
                    const { value } = await reader.read();
                    reader.releaseLock();
                    expect(new TextDecoder().decode(value)).toContain("ready");
                } finally {
                    child.kill(9);
                    await child.exited;
                }
            }
            await runtime.start();
            const response = await fetch("http://localhost/openapi.json", {
                unix,
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toHaveProperty("openapi");
            await runtime.stop();
            expect(closes).toBe(1);
            await expect(
                fetch("http://localhost/openapi.json", { unix }),
            ).rejects.toThrow();
            const rebound = Bun.serve({
                unix,
                fetch: () => new Response("rebound"),
            });
            try {
                expect(
                    await (await fetch("http://localhost", { unix })).text(),
                ).toBe("rebound");
            } finally {
                await rebound.stop(true);
            }
        } finally {
            await runtime.stop();
            await rm(directory, { recursive: true, force: true });
        }
    },
);

test("runtime uses the configured RFC 9068 provider for real HTTP requests", async () => {
    const key = await generateKeyPair("ES256");
    const jwks = {
        keys: [
            {
                ...(await exportJWK(key.publicKey)),
                kid: "runtime",
                alg: "ES256",
                use: "sig",
            },
        ],
    };
    const issuer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => Response.json(jwks),
    });
    const client = new PGlite();
    const db = drizzle(client, { schema: schema.definition });
    const config = new ApplicationConfig({
        auth: {
            ...testAuthSettings,
            issuer: issuer.url.href,
            jwksUrl: issuer.url.href,
        },
        database: { url: databaseUrl },
        serve: { port: 0 },
        storage: { backend: "local", directory: "./data/blobs" },
    });
    const runtime = new ApplicationRuntime(config, {
        connect: async () => ({ db, close: () => client.close() }),
    });
    const accessToken = (sub: string, scope: string) =>
        new SignJWT({ scope, client_id: "runtime-client" })
            .setProtectedHeader({ alg: "ES256", kid: "runtime", typ: "at+jwt" })
            .setIssuer(issuer.url.href)
            .setAudience(testAuthSettings.audience)
            .setSubject(sub)
            .setIssuedAt()
            .setExpirationTime("5m")
            .setJti(crypto.randomUUID())
            .sign(key.privateKey);
    try {
        await migrate(db, {
            migrationsFolder: fileURLToPath(
                new URL("../../migrations/", import.meta.url),
            ),
        });
        await runtime.start();
        const url = new URL("/api/photos", runtime.url);
        expect((await fetch(url)).status).toBe(401);
        const reader = await accessToken("test-user", "photos:read");
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${reader}` },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            items: [],
            limit: 50,
            offset: 0,
        });
        expect(
            (
                await fetch(url, {
                    headers: {
                        Authorization: `Bearer ${await accessToken("other-user", "photos:read")}`,
                    },
                })
            ).status,
        ).toBe(403);
        const uploadId = await readyUpload(db, undefined, {
            ...testAuthIdentity,
            issuer: issuer.url.href,
        });
        const create = (token: string) =>
            fetch(url, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    uploadId,
                    taken: "2026-10-02T12:00:00Z",
                    posted: "2026-10-02T12:00:00Z",
                    alt: "Photo",
                    description: "",
                    enabled: true,
                }),
            });
        expect((await create(reader)).status).toBe(403);
        expect(
            (await create(await accessToken("test-user", "photos:create")))
                .status,
        ).toBe(201);
    } finally {
        try {
            await runtime.stop();
        } finally {
            await issuer.stop(true);
            if (!client.closed) await client.close();
        }
    }
}, 30_000);

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
                auth: testAuthSettings,
                database: { url: databaseUrl },
                serve: { port: 0 },
                storage: { backend: "local", directory: "./data/blobs" },
            }),
            {
                authentication: testAuthentication,
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
        const created = await fetch(new URL("/api/photos", runtime.url), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer test-token",
            },
            body: JSON.stringify({
                uploadId: await readyUpload(db),
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
                new URL(`/api/photos/${photo.id}/uploads`, runtime.url),
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: "Bearer test-token",
                    },
                    body: JSON.stringify({ contentType: "image/png" }),
                },
            );
            expect(uploaded.status).toBe(201);
            expect(await uploaded.json()).toMatchObject({
                upload: { method: "PUT" },
            });
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
                    auth: testAuthSettings,
                    database: { url: databaseUrl },
                    storage: { backend: "local", directory: "./data/blobs" },
                    serve: { port: occupied.port! },
                }),
                {
                    authentication: testAuthentication,
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
            auth: testAuthSettings,
            database: { url: databaseUrl },
            storage: { backend: "local", directory: "./data/blobs" },
            serve: { port: 0 },
        }),
        {
            authentication: testAuthentication,
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

test("configured no-auth supports header-free reads and writes with stable upload ownership", async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema: schema.definition });
    const runtime = new ApplicationRuntime(
        new ApplicationConfig({
            auth: { kind: "no-auth" },
            database: { url: databaseUrl },
            serve: { port: 0 },
            storage: { backend: "local", directory: "./data/blobs" },
        }),
        { connect: async () => ({ db, close: () => client.close() }) },
    );
    try {
        await migrate(db, {
            migrationsFolder: fileURLToPath(
                new URL("../../migrations/", import.meta.url),
            ),
        });
        const uploadId = await readyUpload(
            db,
            undefined,
            await new NoAuthenticationProvider().authenticate(),
        );
        await runtime.start();
        const url = new URL("/api/photos", runtime.url);
        expect((await fetch(url)).status).toBe(200);
        const created = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                uploadId,
                taken: "2026-10-02T12:00:00Z",
                posted: "2026-10-02T12:00:00Z",
                alt: "Test",
                description: "",
                enabled: true,
            }),
        });
        expect(created.status).toBe(201);
        const location = new URL(created.headers.get("Location")!, runtime.url);
        expect(
            (
                await fetch(location, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ alt: "Updated" }),
                })
            ).status,
        ).toBe(200);
        expect(await (await fetch(location)).json()).toMatchObject({
            alt: "Updated",
        });
        expect((await fetch(location, { method: "DELETE" })).status).toBe(204);
        const document = await (
            await fetch(new URL("/openapi.json", runtime.url))
        ).json();
        expect(document).toMatchObject({
            security: [],
            components: { securitySchemes: {} },
        });
    } finally {
        await runtime.stop();
        if (!client.closed) await client.close();
    }
});
