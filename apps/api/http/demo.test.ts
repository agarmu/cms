import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { DatabaseSchema } from "../db/schema";
import { PhotoApi } from "../api/photos";
import { testAuthentication } from "../auth/test-fixtures";
import { ImageStorage } from "../services/image-storage";
import { HttpApplication } from "./app";
import { HttpConfiguration } from "./config";

const clients = [new PGlite(), new PGlite()];
const mainDb = drizzle(clients[0]!, { schema: DatabaseSchema.definition });
const demoDb = drizzle(clients[1]!, { schema: DatabaseSchema.definition });
const photoId = "30000000-0000-4000-8000-000000000001";
const errors: Error[] = [];
let storageReads = 0;
const demoStorage = new ImageStorage({
    get: async () => undefined,
    read: async (key) => {
        storageReads++;
        return key === `images/${photoId}/original.webp`
            ? { file: new Blob(["demo image"], { type: "image/webp" }) }
            : undefined;
    },
    write: async () => {
        throw new Error("Demo requests must not write images");
    },
    delete: async () => {
        throw new Error("Demo requests must not delete images");
    },
});
const options = {
    db: mainDb,
    authentication: testAuthentication,
    reportError: (error: Error) => errors.push(error),
    getImageStorage: () => {
        throw new Error("Demo requests must not initialize real image storage");
    },
};
const app = new HttpApplication(
    { ...options, demo: { db: demoDb, getImageStorage: () => demoStorage } },
    new HttpConfiguration({ allowedOrigins: ["http://localhost:4321"] }),
);
const request = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://localhost${path}`, init));

beforeAll(async () => {
    const folder = fileURLToPath(
        new URL("../../../migrations/", import.meta.url),
    );
    for (const db of [mainDb, demoDb])
        await migrate(db, { migrationsFolder: folder });
    for (const [db, caption] of [
        [mainDb, "Private photo"],
        [demoDb, "Demo photo"],
    ] as const)
        await PhotoApi.create(
            db,
            {
                caption,
                altText: caption,
                description: "Photographer credit",
                location: null,
                takenAt: new Date("2017-01-01T12:00:00Z"),
                postedAt: new Date("2026-10-01T12:00:00Z"),
                visible: false,
                camera: { create: { name: `${caption} camera` } },
                lens: null,
                assets: [
                    {
                        assetLocation: "original.webp",
                        width: 1200,
                        height: 800,
                        byteSize: 10,
                    },
                ],
            },
            photoId,
        );
}, 30_000);
afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    expect(errors).toEqual([]);
});

test("anonymous demo reads use the demo database even when real IDs match", async () => {
    const list = await request("/api/demo/photos?limit=25&offset=0", {
        headers: { Origin: "http://localhost:4321" },
    });
    expect(list.status).toBe(200);
    expect(list.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://localhost:4321",
    );
    expect(await list.json()).toMatchObject({
        items: [
            {
                id: photoId,
                caption: "Demo photo",
                visible: false,
                assets: [
                    { url: `/api/demo/photos/${photoId}/assets/original.webp` },
                ],
            },
        ],
        limit: 25,
        offset: 0,
    });
    const photo = await request(`/api/demo/photos/${photoId}`);
    expect(photo.status).toBe(200);
    expect(await photo.json()).toMatchObject({ caption: "Demo photo" });
    const cameras = await request("/api/demo/cameras");
    expect(await cameras.json()).toMatchObject({
        items: [{ name: "Demo photo camera" }],
    });
    expect(await (await request("/api/demo/lenses")).json()).toMatchObject({
        items: [],
    });
    expect((await request("/api/photos")).status).toBe(401);
    const privatePhoto = await request(`/api/photos/${photoId}`, {
        headers: { Authorization: "Bearer test-token" },
    });
    expect(await privatePhoto.json()).toMatchObject({
        caption: "Private photo",
    });
});

test("demo assets are served on demand from demo storage", async () => {
    expect(storageReads).toBe(0);
    const response = await request(
        `/api/demo/photos/${photoId}/assets/original.webp`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(await response.text()).toBe("demo image");
    expect(storageReads).toBe(1);
    expect(
        (await request(`/api/demo/photos/${photoId}/assets/private.webp`))
            .status,
    ).toBe(404);
    expect(storageReads).toBe(1);
});

test("demo mutations and upload endpoints are rejected before touching either database", async () => {
    const mainBefore = await mainDb.query.photos.findMany();
    const demoBefore = await demoDb.query.photos.findMany();
    for (const method of ["POST", "PATCH", "PUT", "DELETE"])
        for (const path of [
            "/api/demo/photos",
            `/api/demo/photos/${photoId}`,
            "/api/demo/cameras",
            "/api/demo/photo-uploads",
            `/api/demo/photos/${photoId}/uploads`,
        ]) {
            const response = await request(path, {
                method,
                headers: {
                    Authorization: "Bearer test-token",
                    "Content-Type": "application/json",
                },
                body: "{}",
            });
            expect(response.status).toBe(405);
            expect(response.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
        }
    expect(await mainDb.query.photos.findMany()).toEqual(mainBefore);
    expect(await demoDb.query.photos.findMany()).toEqual(demoBefore);
});

test("demo queries validate parameters and never fall back to the real database", async () => {
    expect((await request("/api/demo/photos?limit=101")).status).toBe(400);
    expect((await request("/api/demo/photos/not-a-uuid")).status).toBe(400);
    expect(
        (await request("/api/demo/photos/40000000-0000-4000-8000-000000000000"))
            .status,
    ).toBe(404);
    const disabled = new HttpApplication(options);
    expect(
        (await disabled.fetch(new Request("http://localhost/api/demo/photos")))
            .status,
    ).toBe(404);
    expect(
        (
            await disabled.fetch(
                new Request(`http://localhost/api/demo/photos/${photoId}`),
            )
        ).status,
    ).toBe(404);
    expect(
        (await disabled.fetch(new Request("http://localhost/api/photos")))
            .status,
    ).toBe(401);
});

test("OpenAPI marks demo reads as public and exposes no demo writes", async () => {
    const document = (await (await request("/openapi.json")).json()) as {
        paths: Record<string, Record<string, { security?: unknown }>>;
    };
    expect(document.paths["/api/demo/photos"]?.["get"]?.security).toEqual([]);
    expect(document.paths["/api/demo/photos"]?.["post"]).toBeUndefined();
    expect(document.paths["/api/demo/photos/{id}"]?.["patch"]).toBeUndefined();
});
