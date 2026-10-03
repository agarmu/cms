import { afterAll, beforeAll, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";

const { cameras, imageAssets, images, lenses } = schema;
const client = new PGlite();
const testDb = drizzle(client, { schema });

beforeAll(
    () =>
        migrate(testDb, {
            migrationsFolder: fileURLToPath(
                new URL("../../migrations/", import.meta.url),
            ),
        }),
    30_000,
);

afterAll(() => client.close());

const imageMetadata = {
    taken: new Date("2026-10-02T12:00:00Z"),
    posted: new Date("2026-10-02T13:00:00Z"),
    alt: "A photograph",
    description: "Evening light",
    enabled: true,
};

test("loads an image with its camera, lens, and assets", async () => {
    const camera = { id: crypto.randomUUID(), name: "Camera" };
    const lens = { id: crypto.randomUUID(), name: "Lens" };
    const image = {
        ...imageMetadata,
        id: crypto.randomUUID(),
        cameraId: camera.id,
        lensId: lens.id,
    };

    await testDb.insert(cameras).values(camera);
    await testDb.insert(lenses).values(lens);
    await testDb.insert(images).values(image);
    const assets = await testDb
        .insert(imageAssets)
        .values({
            photoId: image.id,
            width: 640,
            height: 320,
            assetLocation: "https://cdn.example.test/photo.webp",
        })
        .returning();

    const loaded = await testDb.query.images.findFirst({
        where: (table, { eq }) => eq(table.id, image.id),
        with: { camera: true, lens: true, assets: true },
    });
    expect(assets).toHaveLength(1);
    expect(loaded).toEqual({ ...image, camera, lens, assets });
});

const invalidDimensions = [
    ["width", 0, 320],
    ["height", 640, -1],
] satisfies [string, number, number][];

test.each(invalidDimensions)(
    "rejects non-positive %s",
    async (dimension, width, height) => {
        const image = { ...imageMetadata, id: crypto.randomUUID() };
        await testDb.insert(images).values(image);

        const insert = testDb.insert(imageAssets).values({
            photoId: image.id,
            width,
            height,
            assetLocation: "https://cdn.example.test/photo.webp",
        });

        await rejects(insert.execute(), (error: unknown) => {
            expect(error).toMatchObject({
                cause: {
                    code: "23514",
                    constraint: `image_assets_${dimension}_positive`,
                },
            });
            return true;
        });

        const assets = await testDb.query.imageAssets.findMany({
            where: (table, { eq }) => eq(table.photoId, image.id),
        });
        expect(assets).toEqual([]);
    },
);
