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
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { z } from "zod";
import { DatabaseSchema as schema } from "../db/schema";
import { CameraApi } from "./resources/cameras";
import { ImageApi } from "./resources/images";
import { ImageAssetApi } from "./resources/image-assets";
import { ConflictError } from "../lib/errors";

const client = new PGlite();
const db = drizzle(client, { schema: schema.definition });
beforeAll(
    () =>
        migrate(db, {
            migrationsFolder: fileURLToPath(
                new URL("../../migrations/", import.meta.url),
            ),
        }),
    30_000,
);
afterAll(() => client.close());

const metadata = {
    taken: new Date(),
    posted: new Date(),
    alt: "Photo",
    description: "",
    enabled: true,
};

test("direct API calls validate before accessing the database", async () => {
    const untouched = new Proxy(db, {
        get() {
            throw new Error("Database accessed before validation");
        },
    });
    await expect(
        CameraApi.create(untouched, { name: " " }),
    ).rejects.toBeInstanceOf(z.ZodError);
    await expect(
        CameraApi.update(untouched, crypto.randomUUID(), {}),
    ).rejects.toBeInstanceOf(z.ZodError);
    await expect(
        CameraApi.read(
            untouched,
            "invalid" as ReturnType<typeof crypto.randomUUID>,
        ),
    ).rejects.toBeInstanceOf(z.ZodError);
    await expect(
        CameraApi.list(untouched, { limit: 101, offset: 0 }),
    ).rejects.toBeInstanceOf(z.ZodError);
    await expect(
        ImageApi.create(untouched, { ...metadata, taken: new Date(NaN) }),
    ).rejects.toBeInstanceOf(z.ZodError);
    await expect(
        ImageAssetApi.create(untouched, {
            photoId: crypto.randomUUID(),
            width: 0,
            height: 100,
            assetLocation: "photo.webp",
        }),
    ).rejects.toBeInstanceOf(z.ZodError);
});

test("direct API calls report missing references and blocked deletions as API conflicts", async () => {
    await expect(
        ImageApi.create(db, { ...metadata, cameraId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
        ImageAssetApi.create(db, {
            photoId: crypto.randomUUID(),
            width: 100,
            height: 100,
            assetLocation: "photo.webp",
        }),
    ).rejects.toBeInstanceOf(ConflictError);
    const [camera] = await CameraApi.create(db, { name: " Camera " });
    expect(camera?.name).toBe("Camera");
    const [image] = await ImageApi.create(db, {
        ...metadata,
        cameraId: camera!.id,
    });
    await expect(CameraApi.remove(db, camera!.id)).rejects.toBeInstanceOf(
        ConflictError,
    );
    await expect(
        ImageApi.update(db, image!.id, { lensId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(ConflictError);
    const [asset] = await ImageAssetApi.create(db, {
        photoId: image!.id,
        width: 100,
        height: 100,
        assetLocation: "photo.webp",
    });
    await expect(ImageApi.remove(db, image!.id)).rejects.toBeInstanceOf(
        ConflictError,
    );
    await expect(
        ImageAssetApi.update(db, asset!.id, { photoId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(ConflictError);
    await ImageAssetApi.remove(db, asset!.id);
    await ImageApi.remove(db, image!.id);
    await CameraApi.remove(db, camera!.id);
});
