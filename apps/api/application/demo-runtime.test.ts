import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { DatabaseSchema } from "../db/schema";
import { initializeDatabaseIdentity } from "../db/demo-isolation";
import { ApplicationConfig } from "./config";
import { ApplicationRuntime } from "./runtime";

test.each([false, true])(
    "runtime owns and releases both connections when demo startup fails=%s",
    async (failDemo) => {
        const clients = [new PGlite(), new PGlite()];
        const dbs = clients.map((client) =>
            drizzle(client, { schema: DatabaseSchema.definition }),
        );
        const config = new ApplicationConfig({
            auth: { kind: "no-auth" },
            serve: { port: 0 },
            database: { url: "postgres://localhost/cms" },
            storage: { backend: "local", directory: "./data/blobs" },
            demo: {
                database: { url: "postgres://localhost/cms_demo" },
                storage: { backend: "local", directory: "./data/demo-blobs" },
            },
        });
        const opened: string[] = [];
        const closed: number[] = [];
        const runtime = new ApplicationRuntime(config, {
            connect: async (options) => {
                opened.push("url" in options ? String(options.url) : "");
                const index = opened.length - 1;
                if (index === 1 && failDemo)
                    throw new Error("Demo database unavailable");
                return {
                    db: dbs[index]!,
                    close: async () => {
                        closed.push(index);
                        await clients[index]!.close();
                    },
                };
            },
        });
        try {
            for (const db of dbs) {
                await migrate(db, {
                    migrationsFolder: fileURLToPath(
                        new URL("../../../migrations/", import.meta.url),
                    ),
                });
                await initializeDatabaseIdentity(db);
            }
            if (failDemo) {
                await runtime.start().then(
                    () => {
                        throw new Error("Startup should fail");
                    },
                    (error: Error) =>
                        expect(error.message).toBe("Demo database unavailable"),
                );
                expect(closed).toEqual([0]);
            } else {
                await runtime.start();
                expect(
                    (await fetch(new URL("/api/demo/photos", runtime.url)))
                        .status,
                ).toBe(200);
                await runtime.stop();
                expect(closed).toEqual([1, 0]);
            }
            expect(opened).toEqual([
                "postgres://localhost/cms",
                "postgres://localhost/cms_demo",
            ]);
            await runtime.stop();
            expect(closed).toHaveLength(failDemo ? 1 : 2);
        } finally {
            await runtime.stop();
            for (const client of clients)
                if (!client.closed) await client.close();
        }
    },
    30_000,
);

test.each([
    "hostname alias",
    "copied identity",
    "missing primary identity",
    "missing demo identity",
    "unreadable identity",
] as const)(
    "demo isolation prevents serving and closes both connections: %s",
    async (scenario) => {
        const clients = [new PGlite(), new PGlite()];
        const dbs = clients.map((client) =>
            drizzle(client, { schema: DatabaseSchema.definition }),
        );
        const closed: number[] = [];
        let opened = 0;
        const runtime = new ApplicationRuntime(
            new ApplicationConfig({
                auth: { kind: "no-auth" },
                serve: { port: 0 },
                database: { url: "postgres://owner@localhost/cms" },
                storage: { backend: "local", directory: "./data/blobs" },
                demo: {
                    database: { url: "postgres://demo@127.0.0.1/cms" },
                    storage: {
                        backend: "local",
                        directory: "./data/demo-blobs",
                    },
                },
            }),
            {
                connect: async () => {
                    const index = opened++;
                    return {
                        db: dbs[scenario === "hostname alias" ? 0 : index]!,
                        close: async () => {
                            closed.push(index);
                        },
                    };
                },
            },
        );
        try {
            for (const db of dbs) {
                await migrate(db, {
                    migrationsFolder: fileURLToPath(
                        new URL("../../../migrations/", import.meta.url),
                    ),
                });
                await initializeDatabaseIdentity(db);
            }
            if (scenario === "hostname alias") {
                await dbs[0]!.execute(sql`CREATE SCHEMA alternate`);
                await dbs[0]!.execute(
                    sql`SET search_path TO alternate, public`,
                );
            }
            if (scenario === "copied identity") {
                const [identity] = await dbs[0]!
                    .select()
                    .from(DatabaseSchema.databaseIdentity);
                await dbs[1]!
                    .update(DatabaseSchema.databaseIdentity)
                    .set({ id: identity!.id });
            } else if (scenario === "missing primary identity") {
                await dbs[0]!.delete(DatabaseSchema.databaseIdentity);
            } else if (scenario === "missing demo identity") {
                await dbs[1]!.delete(DatabaseSchema.databaseIdentity);
            } else if (scenario === "unreadable identity") {
                await dbs[1]!.execute(
                    sql`DROP SCHEMA photos_cms_internal CASCADE`,
                );
            }
            await expect(runtime.start()).rejects.toThrow(
                scenario === "hostname alias" || scenario === "copied identity"
                    ? "Demo database must be separate from the primary database"
                    : scenario === "unreadable identity"
                      ? "database_identity"
                      : "Cannot verify demo database isolation",
            );
            expect(() => runtime.url).toThrow("Application has not started");
            expect(closed).toEqual([1, 0]);
            await runtime.stop();
            expect(closed).toEqual([1, 0]);
        } finally {
            await runtime.stop();
            await Promise.all(clients.map((client) => client.close()));
        }
    },
    30_000,
);
