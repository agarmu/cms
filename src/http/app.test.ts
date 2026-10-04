import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { z } from "zod";
import * as schema from "../db/schema";
import { createApp } from "./app";
import { uuid, assetId } from "../api/validation";

const client = new PGlite();
const db = drizzle(client, { schema });
const reportedErrors: Error[] = [];
const app = createApp({
    db,
    reportError: (error) => reportedErrors.push(error),
});
beforeAll(
    () =>
        migrate(db, {
            migrationsFolder: fileURLToPath(
                new URL("../../migrations/", import.meta.url),
            ),
        }),
    30_000,
);
afterAll(async () => {
    await client.close();
    expect(reportedErrors).toEqual([]);
});

function request(path: string, method = "GET", body?: unknown) {
    const headers = new Headers();
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
        headers.set("Content-Type", "application/json");
        init.body = JSON.stringify(body);
    }
    return app.request(path, init);
}

const metadata = {
    taken: "2026-10-02T12:00:00.000Z",
    posted: "2026-10-02T13:00:00.000Z",
    alt: "A photograph",
    description: "Evening light",
    enabled: true,
};
const asset = { width: 640, height: 320, assetLocation: "images/photo.webp" };
const equipment = z.object({ id: uuid, name: z.string() });
const photoRecord = z.object({
    id: uuid,
    cameraId: uuid.nullable(),
    lensId: uuid.nullable(),
    camera: equipment.nullable(),
    lens: equipment.nullable(),
    assets: z.array(
        z.object({
            id: assetId,
            photoId: uuid,
            width: z.number(),
            height: z.number(),
            assetLocation: z.string(),
        }),
    ),
});
async function createPhoto(extra: object = {}) {
    const response = await request("/images", "POST", {
        ...metadata,
        ...extra,
    });
    expect(response.status).toBe(201);
    return photoRecord.parse(await response.json());
}

test("adds, reads, modifies, and removes a photo with assets and explicit new equipment", async () => {
    const photo = await createPhoto({
        camera: { create: { name: " Camera " } },
        lens: { create: { name: "Lens" } },
        assets: [asset],
    });
    expect(photo.camera?.name).toBe("Camera");
    expect(photo.lens?.name).toBe("Lens");
    expect(photo.assets).toMatchObject([{ ...asset, photoId: photo.id }]);
    const loaded = await request(`/images/${photo.id}`);
    expect(await loaded.json()).toMatchObject({ ...metadata, ...photo });
    const updated = await request(`/images/${photo.id}`, "PATCH", {
        enabled: false,
        assets: [{ ...asset, width: 1080 }],
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
        enabled: false,
        assets: [{ ...asset, width: 1080 }],
    });
    expect((await request(`/images/${photo.id}`, "DELETE")).status).toBe(204);
    expect((await request(`/images/${photo.id}`)).status).toBe(404);
    expect(
        await db.query.imageAssets.findMany({
            where: (table, { eq }) => eq(table.photoId, photo.id),
        }),
    ).toEqual([]);
    expect((await request(`/cameras/${photo.cameraId}`)).status).toBe(200);
    expect((await request(`/lenses/${photo.lensId}`)).status).toBe(200);
});

test("uses existing equipment and refuses to delete it while referenced", async () => {
    const first = await createPhoto({
        camera: { create: { name: "Shared camera" } },
        lens: { create: { name: "Shared lens" } },
    });
    const second = await createPhoto({
        camera: { id: first.cameraId },
        lens: { id: first.lensId },
    });
    expect(second.cameraId).toBe(first.cameraId);
    expect(second.lensId).toBe(first.lensId);
    for (const [resource, id] of [
        ["cameras", first.cameraId],
        ["lenses", first.lensId],
    ]) {
        expect((await request(`/${resource}/${id}`, "DELETE")).status).toBe(
            409,
        );
    }
    expect((await request(`/images/${first.id}`, "DELETE")).status).toBe(204);
    expect((await request(`/cameras/${first.cameraId}`, "DELETE")).status).toBe(
        409,
    );
    expect((await request(`/images/${second.id}`, "DELETE")).status).toBe(204);
    for (const [resource, id] of [
        ["cameras", first.cameraId],
        ["lenses", first.lensId],
    ]) {
        expect((await request(`/${resource}/${id}`)).status).toBe(200);
        expect((await request(`/${resource}/${id}`, "DELETE")).status).toBe(
            204,
        );
        expect((await request(`/${resource}/${id}`)).status).toBe(404);
    }
});

test("creates equipment during photo modification and retains detached equipment", async () => {
    const photo = await createPhoto();
    const response = await request(`/images/${photo.id}`, "PATCH", {
        camera: { create: { name: "Added camera" } },
        lens: { create: { name: "Added lens" } },
    });
    expect(response.status).toBe(200);
    const updated = photoRecord.parse(await response.json());
    const detached = await request(`/images/${photo.id}`, "PATCH", {
        camera: null,
        lens: null,
    });
    expect(detached.status).toBe(200);
    expect(await detached.json()).toMatchObject({
        cameraId: null,
        lensId: null,
    });
    expect((await request(`/cameras/${updated.cameraId}`)).status).toBe(200);
    expect((await request(`/lenses/${updated.lensId}`)).status).toBe(200);
});

test("failed photo creation rolls back new equipment", async () => {
    const before = await db.query.cameras.findMany();
    const response = await request("/images", "POST", {
        ...metadata,
        camera: { create: { name: "Should roll back" } },
        lens: { id: crypto.randomUUID() },
    });
    expect(response.status).toBe(409);
    expect(await db.query.cameras.findMany()).toEqual(before);
});

test("failed modification rolls back equipment and leaves the photo unchanged", async () => {
    const photo = await createPhoto({ assets: [asset] });
    const before = await db.query.cameras.findMany();
    const response = await request(`/images/${photo.id}`, "PATCH", {
        camera: { create: { name: "Should roll back" } },
        lens: { id: crypto.randomUUID() },
        assets: [],
    });
    expect(response.status).toBe(409);
    expect(await db.query.cameras.findMany()).toEqual(before);
    expect(
        photoRecord.parse(await (await request(`/images/${photo.id}`)).json()),
    ).toEqual(photo);
});

test("missing photos cannot create equipment during modification", async () => {
    const before = await db.query.cameras.findMany();
    expect(
        (
            await request(`/images/${crypto.randomUUID()}`, "PATCH", {
                camera: { create: { name: "Unused" } },
            })
        ).status,
    ).toBe(404);
    expect(await db.query.cameras.findMany()).toEqual(before);
    expect(
        (await request(`/images/${crypto.randomUUID()}`, "DELETE")).status,
    ).toBe(404);
});

test("an asset insertion failure rolls back replaced assets, metadata, and new equipment", async () => {
    const photo = await createPhoto({ assets: [asset] });
    const before = await db.query.cameras.findMany();
    await client.exec(`
    CREATE FUNCTION reject_test_asset() RETURNS trigger AS $$
    BEGIN
      IF NEW.asset_location = 'reject.webp' THEN
        RAISE EXCEPTION 'Test asset failure' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER reject_test_asset BEFORE INSERT ON image_assets
      FOR EACH ROW EXECUTE FUNCTION reject_test_asset();
  `);
    try {
        const response = await request(`/images/${photo.id}`, "PATCH", {
            enabled: false,
            camera: { create: { name: "Should roll back" } },
            assets: [asset, { ...asset, assetLocation: "reject.webp" }],
        });
        expect(response.status).toBe(400);
        expect(await db.query.cameras.findMany()).toEqual(before);
        expect(
            photoRecord.parse(
                await (await request(`/images/${photo.id}`)).json(),
            ),
        ).toEqual(photo);
        expect(
            await (await request(`/images/${photo.id}`)).json(),
        ).toMatchObject({ enabled: true });
    } finally {
        await client.exec(
            "DROP TRIGGER reject_test_asset ON image_assets; DROP FUNCTION reject_test_asset();",
        );
    }
});

test.each(["cameras", "lenses"])(
    "does not expose standalone creation or modification for %s",
    async (resource) => {
        expect(
            (await request(`/${resource}`, "POST", { name: "Standalone" }))
                .status,
        ).toBe(404);
        expect(
            (
                await request(`/${resource}/${crypto.randomUUID()}`, "PATCH", {
                    name: "Renamed",
                })
            ).status,
        ).toBe(404);
        expect((await request(`/${resource}`)).status).toBe(200);
    },
);

test("assets are managed only through photos", async () => {
    expect(
        (
            await request("/image-assets", "POST", {
                ...asset,
                photoId: crypto.randomUUID(),
            })
        ).status,
    ).toBe(404);
    expect((await request("/image-assets")).status).toBe(404);
    const photo = await createPhoto({ assets: [asset] });
    const response = await request(`/images/${photo.id}`, "PATCH", {
        assets: [],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ assets: [] });
});

const invalidRequests = [
    ["/images", "POST", { ...metadata, camera: { name: "Implicit creation" } }],
    ["/images", "POST", { ...metadata, camera: { create: { name: " " } } }],
    [
        "/images",
        "POST",
        {
            ...metadata,
            camera: { id: crypto.randomUUID(), create: { name: "Ambiguous" } },
        },
    ],
    ["/images", "POST", { ...metadata, taken: "yesterday" }],
    ["/images", "POST", { ...metadata, enabled: "true" }],
    ["/images", "POST", { ...metadata, camera: { id: "invalid" } }],
    ["/images", "POST", { ...metadata, cameraId: crypto.randomUUID() }],
    ["/images", "POST", { ...metadata, assets: [{ ...asset, width: 0 }] }],
    [`/images/${crypto.randomUUID()}`, "PATCH", {}],
    ["/images/invalid", "GET", undefined],
    ["/images?limit=101", "GET", undefined],
    ["/images?offset=-1", "GET", undefined],
] satisfies [string, string, unknown][];
test.each(invalidRequests)(
    "rejects invalid %s %s requests",
    async (path, method, body) => {
        expect((await request(path, method, body)).status).toBe(400);
    },
);

test("rejects malformed JSON, unsupported content types, and oversized bodies", async () => {
    expect(
        (
            await app.request("/images", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{",
            })
        ).status,
    ).toBe(400);
    expect(
        (await app.request("/images", { method: "POST", body: "alt=Photo" }))
            .status,
    ).toBe(400);
    expect(
        (
            await request("/images", "POST", {
                ...metadata,
                description: "x".repeat(65_536),
            })
        ).status,
    ).toBe(413);
});

test.each(["application/json; charset=utf-8", "application/vnd.cms+json"])(
    "uses Hono JSON parsing for %s",
    async (contentType) => {
        const response = await app.request("/images", {
            method: "POST",
            headers: { "Content-Type": contentType },
            body: JSON.stringify(metadata),
        });
        expect(response.status).toBe(201);
    },
);

test("missing JSON content type fails validation for both creation and modification", async () => {
    const photo = await createPhoto();
    for (const [path, method, body] of [
        ["/images", "POST", metadata],
        [`/images/${photo.id}`, "PATCH", { enabled: false }],
    ] as const) {
        const response = await app.request(path, {
            method,
            body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
    }
});

test("paginates photos and returns 404 for unknown routes", async () => {
    await createPhoto();
    await createPhoto();
    const first = await request("/images?limit=1&offset=0");
    const second = await request("/images?limit=1&offset=1");
    expect(await first.json()).toHaveLength(1);
    expect(await second.json()).toHaveLength(1);
    expect((await request("/unknown")).status).toBe(404);
});
