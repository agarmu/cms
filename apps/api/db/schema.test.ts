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

import { afterAll, beforeAll, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { DatabaseSchema as schema } from "./schema";
import { initializeDatabaseIdentity } from "./demo-isolation";

const { cameras, imageAssets, photos, lenses } = schema;
const client = new PGlite();
const testDb = drizzle(client, { schema: schema.definition });

beforeAll(
    () =>
        migrate(testDb, {
            migrationsFolder: fileURLToPath(
                new URL("../../../migrations/", import.meta.url),
            ),
        }),
    30_000,
);

afterAll(() => client.close());

const imageMetadata = {
    takenAt: new Date("2026-10-02T12:00:00Z"),
    postedAt: new Date("2026-10-02T13:00:00Z"),
    altText: "A photograph",
    caption: "Evening light",
    description: "Light falls across the **mountains**.",
    location: null,
    visible: true,
};

test("ORM initialization creates one persistent database identity", async () => {
    expect(await testDb.select().from(schema.databaseIdentity)).toEqual([]);
    await initializeDatabaseIdentity(testDb);
    const original = await testDb.select().from(schema.databaseIdentity);
    expect(original).toHaveLength(1);
    expect(original[0]).toMatchObject({
        singleton: true,
        id: expect.any(String),
    });
    await Promise.all([
        initializeDatabaseIdentity(testDb),
        initializeDatabaseIdentity(testDb),
    ]);
    expect(await testDb.select().from(schema.databaseIdentity)).toEqual(
        original,
    );
});

test("adding description preserves existing caption and alt text", async () => {
    const upgrade = new PGlite();
    try {
        await upgrade.exec(`
            CREATE TABLE photos (caption text NOT NULL, alt_text text NOT NULL);
            INSERT INTO photos VALUES ('Existing caption', 'Existing alt text');
        `);
        await upgrade.exec(
            await Bun.file(
                new URL(
                    "../../../migrations/0005_photo_description.sql",
                    import.meta.url,
                ),
            ).text(),
        );
        const { rows } = await upgrade.query("SELECT * FROM photos");
        expect(rows).toEqual([
            {
                caption: "Existing caption",
                alt_text: "Existing alt text",
                description: "",
            },
        ]);
    } finally {
        await upgrade.close();
    }
});

test("adding byte counts preserves existing assets and rejects non-positive sizes", async () => {
    const upgrade = new PGlite();
    try {
        await upgrade.exec(`
            CREATE TABLE image_assets (asset_location text NOT NULL);
            INSERT INTO image_assets VALUES ('existing.webp');
        `);
        await upgrade.exec(
            await Bun.file(
                new URL(
                    "../../../migrations/0006_image_asset_byte_size.sql",
                    import.meta.url,
                ),
            ).text(),
        );
        expect(
            (await upgrade.query("SELECT * FROM image_assets")).rows,
        ).toEqual([{ asset_location: "existing.webp", byte_size: null }]);
        await upgrade.query(
            "INSERT INTO image_assets VALUES ('new.webp', 3000000000)",
        );
        expect(
            (
                await upgrade.query(
                    "SELECT byte_size FROM image_assets WHERE asset_location = 'new.webp'",
                )
            ).rows,
        ).toEqual([{ byte_size: 3_000_000_000 }]);
        for (const size of [0, -1, Number.MAX_SAFE_INTEGER + 1])
            await expect(
                upgrade.query(
                    "INSERT INTO image_assets VALUES ('invalid.webp', $1)",
                    [size],
                ),
            ).rejects.toThrow();
    } finally {
        await upgrade.close();
    }
});

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
    await testDb.insert(photos).values(image);
    const assets = await testDb
        .insert(imageAssets)
        .values({
            photoId: image.id,
            width: 640,
            height: 320,
            assetLocation: "https://cdn.example.test/photo.webp",
        })
        .returning();

    const loaded = await testDb.query.photos.findFirst({
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
        await testDb.insert(photos).values(image);

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
