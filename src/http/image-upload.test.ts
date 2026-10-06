import { requestAsUser } from "../auth/test-fixtures";
import { testAuthDependencies } from "../auth/test-fixtures";
import { ImageConfiguration } from "../services/image-config";
import { WorkerConfiguration } from "../services/worker-config";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import sharp from "sharp";
import { DatabaseSchema as schema } from "../db/schema";
import { ImageUploadApi } from "../api/image-uploads";
import { PhotoApi } from "../api/photos";
import { ApiValidation } from "../api/validation";
import {
    ImageStorage,
    InvalidAssetLocationError,
} from "../services/image-storage";
import type { ProcessedAsset } from "../services/image-storage";
import { S3Storage } from "../services/s3-storage";
import type { S3Client } from "../services/s3-storage";
import { ImageUploadWorker } from "../services/image-upload-worker";
import { ImageGarbageCollector } from "../services/image-garbage-collector";
import { HttpApplication } from "./app";

const client = new PGlite();
const db = drizzle(client, { schema: schema.definition });
const objects = new Map<string, Uint8Array>();
const signer = new Bun.S3Client({
    bucket: "photos",
    region: "us-east-1",
    accessKeyId: "test-key",
    secretAccessKey: "test-secret",
});
const s3: S3Client = {
    presign: (key, options) => signer.presign(key, options),
    file: (key) => ({
        exists: async () => objects.has(key),
        stat: async () => ({
            size: objects.get(key)!.length,
            lastModified: new Date(),
            etag: "test",
            type: "application/octet-stream",
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
        objects.delete(key);
    },
};
const errors: Error[] = [];
const storage = new ImageStorage(new S3Storage(s3));
const reportError = (error: Error) => errors.push(error);
const app = new HttpApplication({
    ...testAuthDependencies,
    db,
    getImageStorage: () => storage,
    reportError,
});
const check = () =>
    new ImageUploadWorker({
        db,
        getStorage: () => storage,
        reportError,
    }).check();
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
    expect(errors).toEqual([]);
});

async function photo() {
    const response = await requestAsUser(app, "/photos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            taken: "2026-10-02T12:00:00.000Z",
            posted: "2026-10-02T13:00:00.000Z",
            alt: "Photo",
            description: "",
            enabled: true,
        }),
    });
    return (await response.json()) as { id: string };
}
async function initiate(id: string) {
    const response = await requestAsUser(app, `/photos/${id}/uploads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"contentType":"image/png"}',
    });
    expect(response.status).toBe(201);
    const receipt = (await response.json()) as {
        id: string;
        status: string;
        token: string;
        upload: {
            url: string;
            method: string;
            headers: Record<string, string>;
            expiresIn: number;
        };
    };
    expect(receipt.status).toBe("pending");
    expect(receipt).not.toHaveProperty("key");
    const statusUrl = response.headers.get("Location")!;
    expect(statusUrl).toBe(`/photos/${id.toLowerCase()}/uploads/${receipt.id}`);
    return {
        ...receipt.upload,
        uploadId: receipt.id,
        token: receipt.token,
        key: `originals/${id.toLowerCase()}/${receipt.id}`,
        statusUrl,
        completeUrl: `${statusUrl}/complete`,
        cancelUrl: `${statusUrl}/cancel`,
    };
}
const status = async (upload: { statusUrl: string }) =>
    (await (await requestAsUser(app, upload.statusUrl)).json()) as {
        status: string;
        error: string | null;
    };
const due = (uploadId: string) =>
    db
        .update(schema.imageUploads)
        .set({ nextCheck: new Date(0) })
        .where(eq(schema.imageUploads.id, ApiValidation.uuid.parse(uploadId)))
        .execute();
const process = (id: string, uploadId: string) =>
    ImageUploadApi.complete(
        db,
        storage,
        ApiValidation.uuid.parse(id),
        ApiValidation.uuid.parse(uploadId),
    );
const png = await sharp({
    create: { width: 1000, height: 500, channels: 3, background: "red" },
})
    .png()
    .toBuffer();
const collect = () =>
    new ImageGarbageCollector({
        db,
        getStorage: () => storage,
        reportError,
    }).collect();
const garbageFor = (id: string) =>
    db
        .select()
        .from(schema.imageAssetGarbage)
        .where(
            eq(schema.imageAssetGarbage.photoId, ApiValidation.uuid.parse(id)),
        )
        .execute();
const garbageDue = (id: string) =>
    db
        .update(schema.imageAssetGarbage)
        .set({ nextCheck: new Date(0) })
        .where(
            eq(schema.imageAssetGarbage.photoId, ApiValidation.uuid.parse(id)),
        )
        .execute();
const assetInput = ({ width, height, assetLocation }: ProcessedAsset) => ({
    width,
    height,
    assetLocation,
});

async function uploadedPhoto(id: string) {
    const upload = await initiate(id);
    objects.set(upload.key, png);
    return process(id, upload.uploadId);
}

test("issues a presigned PUT and automatically processes the original on a scheduled check", async () => {
    const { id } = await photo();
    const upload = await initiate(id);
    expect(upload.method).toBe("PUT");
    expect(upload.headers).toEqual({ "Content-Type": "image/png" });
    const url = new URL(upload.url);
    expect(url.pathname.endsWith(`/${upload.key}`)).toBe(true);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.has("X-Amz-Signature")).toBe(true);
    expect(objects.has(upload.key)).toBe(false);
    const [receipt] = await db
        .select()
        .from(schema.imageUploads)
        .where(
            eq(
                schema.imageUploads.id,
                ApiValidation.uuid.parse(upload.uploadId),
            ),
        )
        .execute();
    expect(receipt!.nextCheck.getTime() - receipt!.created.getTime()).toBe(
        15 * 60 * 1000,
    );
    objects.set(upload.key, png);
    await check();
    expect((await status(upload)).status).toBe("pending");
    objects.delete(upload.key);
    await due(upload.uploadId);
    await check();
    expect((await status(upload)).status).toBe("pending");
    // Simulate the client's direct PUT to S3; no original bytes pass through a service route.
    objects.set(upload.key, png);
    // Respect the persisted delay until the next check.
    await check();
    expect((await status(upload)).status).toBe("pending");
    await due(upload.uploadId);
    await check();
    expect((await status(upload)).status).toBe("completed");
    const result = (await (
        await requestAsUser(app, `/photos/${id}`)
    ).json()) as {
        assets: {
            filename: string;
            url: string;
            width: number;
            height: number;
        }[];
    };
    expect(result.assets.map(({ width, height }) => [width, height])).toEqual([
        [640, 320],
    ]);
    expect(objects.get(upload.key)).toEqual(png);
    expect(
        [...objects.keys()].filter((key) => key.startsWith(`images/${id}/`)),
    ).toHaveLength(1);
    const redirect = await requestAsUser(app, `/photos/${id}/image`);
    const download = await requestAsUser(
        app,
        redirect.headers.get("Location")!,
    );
    expect(download.status).toBe(302);
    expect(redirect.headers.get("Location")).toBe(result.assets[0]!.url);
    const largest = objects.get(`images/${id}/${result.assets[0]!.filename}`)!;
    expect((await sharp(largest).metadata()).width).toBe(640);
});

test("repeated and concurrent processing does not create additional assets", async () => {
    const { id } = await photo();
    const upload = await initiate(id);
    objects.set(upload.key, png);
    const [first, second] = await Promise.all([
        process(id, upload.uploadId),
        process(id, upload.uploadId),
    ]);
    expect(first).toEqual(second);
    const before = [...objects.keys()];
    await process(id, upload.uploadId);
    expect([...objects.keys()]).toEqual(before);
});

test("uppercase photo IDs use canonical keys for scheduled uploads and asset reads", async () => {
    const { id } = await photo();
    const upload = await initiate(id.toUpperCase());
    expect(upload.key).toBe(`originals/${id}/${upload.uploadId}`);
    expect(upload.statusUrl).toBe(`/photos/${id}/uploads/${upload.uploadId}`);
    objects.set(upload.key, png);
    await due(upload.uploadId);
    await check();
    expect((await status(upload)).status).toBe("completed");

    const redirect = await requestAsUser(
        app,
        `/photos/${id.toUpperCase()}/image`,
    );
    expect(redirect.status).toBe(302);
    const assetUrl = redirect.headers.get("Location")!;
    expect(assetUrl.startsWith(`/photos/${id}/`)).toBe(true);
    const download = await requestAsUser(
        app,
        assetUrl.replace(id, id.toUpperCase()),
    );
    expect(download.status).toBe(302);
    const key = new URL(download.headers.get("Location")!).pathname
        .split("/")
        .slice(-3)
        .join("/");
    expect(objects.has(key)).toBe(true);
});

test("uppercase photo and upload IDs can complete an upload immediately", async () => {
    const { id } = await photo();
    const upload = await initiate(id);
    objects.set(upload.key, png);
    const response = await control(
        `/photos/${id.toUpperCase()}/uploads/${upload.uploadId.toUpperCase()}/complete`,
        "POST",
        {
            token: upload.token,
        },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
        status: "completed",
        id: upload.uploadId,
    });
    const result = await process(id, upload.uploadId);
    expect(result.assets).toHaveLength(1);
    expect(objects.has(`images/${id}/${result.assets[0]!.assetLocation}`)).toBe(
        true,
    );
});

test("completed jobs cannot replace a newer upload", async () => {
    const { id } = await photo();
    const first = await initiate(id);
    objects.set(first.key, png);
    await process(id, first.uploadId);
    const second = await initiate(id);
    objects.set(second.key, png);
    const saved = await process(id, second.uploadId);
    expect(await process(id, first.uploadId)).toEqual(saved);
});

test("replacement queues obsolete assets and GC respects the grace period", async () => {
    const { id } = await photo();
    const first = await uploadedPhoto(id);
    await PhotoApi.update(db, ApiValidation.uuid.parse(id), {
        assets: first.assets.map(assetInput),
    });
    expect(await garbageFor(id)).toEqual([]);
    const second = await uploadedPhoto(id);
    const garbage = await garbageFor(id);
    expect(garbage.map((asset) => asset.assetLocation)).toEqual(
        first.assets.map((asset) => asset.assetLocation),
    );
    expect(garbage[0]!.nextCheck.getTime()).toBeGreaterThan(
        Date.now() + 59 * 60 * 1000,
    );
    await collect();
    expect(objects.has(`images/${id}/${first.assets[0]!.assetLocation}`)).toBe(
        true,
    );
    await garbageDue(id);
    // Recreate storage as after a restart; the database retains the GC schedule.
    await new ImageGarbageCollector({
        db,
        getStorage: () => new ImageStorage(new S3Storage(s3)),
        reportError,
    }).collect();
    expect(objects.has(`images/${id}/${first.assets[0]!.assetLocation}`)).toBe(
        false,
    );
    expect(objects.has(`images/${id}/${second.assets[0]!.assetLocation}`)).toBe(
        true,
    );
    expect(await garbageFor(id)).toEqual([]);
});

test("photo deletion preserves queued object keys for GC", async () => {
    const { id } = await photo();
    const saved = await uploadedPhoto(id);
    expect(
        (
            await requestAsUser(app, `/photos/${id.toUpperCase()}`, {
                method: "DELETE",
            })
        ).status,
    ).toBe(204);
    expect(await garbageFor(id)).toHaveLength(1);
    await garbageDue(id);
    await collect();
    expect(objects.has(`images/${id}/${saved.assets[0]!.assetLocation}`)).toBe(
        false,
    );
    expect(await garbageFor(id)).toEqual([]);
});

test("GC keeps assets that were reattached and their next removal restarts the grace period", async () => {
    const { id } = await photo();
    const saved = await uploadedPhoto(id);
    await PhotoApi.update(db, ApiValidation.uuid.parse(id), { assets: [] });
    await garbageDue(id);
    await PhotoApi.update(db, ApiValidation.uuid.parse(id), {
        assets: [...saved.assets, ...saved.assets].map(assetInput),
    });
    await collect();
    expect(objects.has(`images/${id}/${saved.assets[0]!.assetLocation}`)).toBe(
        true,
    );
    expect(await garbageFor(id)).toEqual([]);
    await PhotoApi.update(db, ApiValidation.uuid.parse(id), { assets: [] });
    expect(await garbageFor(id)).toHaveLength(1);
    await garbageDue(id);
    // Remove again before GC runs: even an existing queue entry gets a new grace period.
    await db
        .update(schema.imageAssetGarbage)
        .set({ retryCount: 5, failed: "Exhausted" })
        .where(
            eq(schema.imageAssetGarbage.photoId, ApiValidation.uuid.parse(id)),
        )
        .execute();
    await PhotoApi.update(db, ApiValidation.uuid.parse(id), {
        assets: saved.assets.map(assetInput),
    });
    await PhotoApi.update(db, ApiValidation.uuid.parse(id), { assets: [] });
    expect((await garbageFor(id))[0]).toMatchObject({
        retryCount: 0,
        failed: null,
    });
    expect((await garbageFor(id))[0]!.nextCheck.getTime()).toBeGreaterThan(
        Date.now() + 59 * 60 * 1000,
    );
    await collect();
    expect(objects.has(`images/${id}/${saved.assets[0]!.assetLocation}`)).toBe(
        true,
    );
    await garbageDue(id);
    await collect();
    expect(objects.has(`images/${id}/${saved.assets[0]!.assetLocation}`)).toBe(
        false,
    );
});

test("failed replacement rolls back the GC queue along with assets", async () => {
    const { id } = await photo();
    const saved = await uploadedPhoto(id);
    const assets = saved.assets.map(assetInput);
    await client.exec(`
    CREATE FUNCTION reject_gc_replacement() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Test replacement failure' USING ERRCODE = '23514';
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER reject_gc_replacement BEFORE INSERT ON image_assets
      FOR EACH ROW EXECUTE FUNCTION reject_gc_replacement();
  `);
    try {
        const response = await control(`/photos/${id}`, "PATCH", {
            assets: assets.map(({ width, height }) => ({
                width,
                height,
                filename: "new.webp",
            })),
        });
        expect(response.status).toBe(400);
        expect(await garbageFor(id)).toEqual([]);
        expect(
            (await PhotoApi.read(db, ApiValidation.uuid.parse(id))).assets,
        ).toEqual(saved.assets);
    } finally {
        await client.exec(
            "DROP TRIGGER reject_gc_replacement ON image_assets; DROP FUNCTION reject_gc_replacement();",
        );
    }
});

test("GC retains failed deletions for retry", async () => {
    const { id } = await photo();
    const saved = await uploadedPhoto(id);
    await PhotoApi.update(db, ApiValidation.uuid.parse(id), { assets: [] });
    // PostgreSQL stores microseconds; retry scheduling must not depend on Date equality.
    await db
        .update(schema.imageAssetGarbage)
        .set({ nextCheck: sql`'2026-01-01 00:00:00.123456+00'::timestamptz` })
        .where(
            eq(schema.imageAssetGarbage.photoId, ApiValidation.uuid.parse(id)),
        )
        .execute();
    const key = `images/${id}/${saved.assets[0]!.assetLocation}`;
    const deletionError = new Error("Temporary S3 failure");
    const gcErrors: Error[] = [];
    const originalDelete = s3.delete;
    s3.delete = async (objectKey) => {
        if (objectKey === key) throw deletionError;
        await originalDelete(objectKey);
    };
    try {
        await new ImageGarbageCollector({
            db,
            getStorage: () => storage,
            reportError: (error) => gcErrors.push(error),
        }).collect();
        expect(gcErrors).toEqual([deletionError]);
        expect(objects.has(key)).toBe(true);
        expect((await garbageFor(id))[0]!.nextCheck.getTime()).toBeGreaterThan(
            Date.now(),
        );
    } finally {
        s3.delete = originalDelete;
    }
    await collect();
    expect(objects.has(key)).toBe(true);
    await garbageDue(id);
    await collect();
    expect(objects.has(key)).toBe(false);
    expect(await garbageFor(id)).toEqual([]);
});

test("a failed GC transaction keeps the entry for an idempotent retry", async () => {
    const { id } = await photo();
    const saved = await uploadedPhoto(id);
    await PhotoApi.update(db, ApiValidation.uuid.parse(id), { assets: [] });
    await garbageDue(id);
    const key = `images/${id}/${saved.assets[0]!.assetLocation}`;
    const gcErrors: Error[] = [];
    await client.exec(`
    CREATE FUNCTION reject_gc_acknowledgement() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Test GC transaction failure' USING ERRCODE = '23514';
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER reject_gc_acknowledgement BEFORE DELETE ON image_asset_garbage
      FOR EACH ROW EXECUTE FUNCTION reject_gc_acknowledgement();
  `);
    try {
        await new ImageGarbageCollector({
            db,
            getStorage: () => storage,
            reportError: (error) => gcErrors.push(error),
        }).collect();
        expect(gcErrors).toHaveLength(1);
        expect(objects.has(key)).toBe(false);
        expect(await garbageFor(id)).toHaveLength(1);
    } finally {
        await client.exec(
            "DROP TRIGGER reject_gc_acknowledgement ON image_asset_garbage; DROP FUNCTION reject_gc_acknowledgement();",
        );
    }
    await collect();
    expect(objects.has(key)).toBe(false);
    expect(await garbageFor(id)).toEqual([]);
});

test("GC reports unsupported asset locations and retains their records", async () => {
    const { id } = await photo();
    await PhotoApi.update(db, ApiValidation.uuid.parse(id), {
        assets: [{ width: 640, height: 320, assetLocation: "../outside.webp" }],
    });
    await PhotoApi.update(db, ApiValidation.uuid.parse(id), { assets: [] });
    await garbageDue(id);
    const gcErrors: Error[] = [];
    const before = [...objects.keys()];
    await new ImageGarbageCollector({
        db,
        getStorage: () => storage,
        reportError: (error) => gcErrors.push(error),
    }).collect();
    expect(gcErrors).toHaveLength(1);
    expect(gcErrors[0]).toBeInstanceOf(InvalidAssetLocationError);
    expect([...objects.keys()]).toEqual(before);
    expect(await garbageFor(id)).toHaveLength(1);
    expect((await garbageFor(id))[0]!.nextCheck.getTime()).toBeGreaterThan(
        Date.now(),
    );
});

test("invalid and oversized originals fail without changing photo assets", async () => {
    const { id } = await photo();
    const truncated = png.subarray(0, Math.floor(png.length / 2));
    // Metadata can be readable even when the pixel data fails during conversion.
    expect((await sharp(truncated).metadata()).width).toBe(1000);
    for (const bytes of [
        new Uint8Array(),
        new TextEncoder().encode("broken"),
        truncated,
        new Uint8Array(new ImageConfiguration().maxBytes + 1),
    ]) {
        const upload = await initiate(id);
        objects.set(upload.key, bytes);
        await due(upload.uploadId);
        await check();
        expect((await status(upload)).status).toBe("failed");
        expect(
            [...objects.keys()].filter((key) =>
                key.startsWith(`images/${id}/`),
            ),
        ).toHaveLength(0);
    }
    const upload = await initiate(id);
    objects.set(upload.key, await sharp(png).avif().toBuffer());
    await due(upload.uploadId);
    await check();
    expect((await status(upload)).status).toBe("completed");
});

test("rejects multipart uploads, invalid content types, and status requests for another photo", async () => {
    const first = await photo();
    const second = await photo();
    const upload = await initiate(first.id);
    expect(
        (
            await requestAsUser(
                app,
                `/photos/${second.id}/uploads/${upload.uploadId}`,
            )
        ).status,
    ).toBe(404);
    expect(
        (
            await requestAsUser(
                app,
                `/photos/${first.id}/uploads/${crypto.randomUUID()}`,
            )
        ).status,
    ).toBe(404);
    expect(
        (await requestAsUser(app, `/photos/${first.id}/uploads/invalid`))
            .status,
    ).toBe(400);
    const form = new FormData();
    form.set("file", new File([png], "photo.png"));
    expect(
        (
            await requestAsUser(app, `/photos/${first.id}/uploads`, {
                method: "POST",
                body: form,
            })
        ).status,
    ).toBe(400);
    expect(
        (
            await requestAsUser(app, `/photos/${first.id}/uploads`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: '{"contentType":"text/plain"}',
            })
        ).status,
    ).toBe(400);
});

test("database failure removes variants, retains the original, and schedules another attempt", async () => {
    const { id } = await photo();
    const upload = await initiate(id);
    objects.set(upload.key, png);
    const before = [...objects.keys()];
    await client.exec(`
    CREATE FUNCTION reject_upload() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Test upload failure' USING ERRCODE = '23514';
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER reject_upload BEFORE INSERT ON image_assets
      FOR EACH ROW EXECUTE FUNCTION reject_upload();
  `);
    try {
        await due(upload.uploadId);
        await check();
        expect(errors.splice(0)).toHaveLength(1);
        expect((await status(upload)).status).toBe("pending");
        expect([...objects.keys()]).toEqual(before);
        const [receipt] = await db
            .select()
            .from(schema.imageUploads)
            .where(
                eq(
                    schema.imageUploads.id,
                    ApiValidation.uuid.parse(upload.uploadId),
                ),
            )
            .execute();
        expect(receipt!.nextCheck.getTime()).toBeGreaterThan(Date.now());
    } finally {
        await client.exec(
            "DROP TRIGGER reject_upload ON image_assets; DROP FUNCTION reject_upload();",
        );
    }
    await due(upload.uploadId);
    await check();
    expect((await status(upload)).status).toBe("completed");
});

test("a database failure during image preparation keeps its error type and is retried", async () => {
    const { id } = await photo();
    const upload = await initiate(id);
    objects.set(upload.key, png);
    const before = [...objects.keys()];
    class DatabaseConnectionError extends Error {}
    const connectionError = new DatabaseConnectionError(
        "Temporary database connection failure",
    );
    let receiptReads = 0;
    const retryDb = drizzle(client, {
        schema: schema.definition,
        logger: {
            logQuery(query) {
                if (
                    query.startsWith("select") &&
                    query.includes('from "image_uploads"') &&
                    !query.includes("order by")
                ) {
                    // Initial receipt, pre-download check, post-download check, then the
                    // check inside preparation immediately before decoding a variant.
                    if (++receiptReads === 4) throw connectionError;
                }
            },
        },
    });
    const retryErrors: Error[] = [];
    const retryCheck = () =>
        new ImageUploadWorker({
            db: retryDb,
            getStorage: () => storage,
            reportError: (error) => retryErrors.push(error),
        }).check();
    await due(upload.uploadId);
    await retryCheck();
    expect(receiptReads).toBe(4);
    expect(retryErrors).toEqual([connectionError]);
    expect(retryErrors[0]).toBeInstanceOf(DatabaseConnectionError);
    expect(await status(upload)).toMatchObject({
        status: "pending",
        error: null,
    });
    expect([...objects.keys()]).toEqual(before);
    const [receipt] = await db
        .select()
        .from(schema.imageUploads)
        .where(
            eq(
                schema.imageUploads.id,
                ApiValidation.uuid.parse(upload.uploadId),
            ),
        )
        .execute();
    expect(receipt!.nextCheck.getTime()).toBeGreaterThan(Date.now());

    await due(upload.uploadId);
    await retryCheck();
    expect((await status(upload)).status).toBe("completed");
    expect(retryErrors).toEqual([connectionError]);
});

test("a new worker resumes persisted jobs and expires abandoned uploads", async () => {
    const { id } = await photo();
    const arrived = await initiate(id);
    const abandoned = await initiate(id);
    objects.set(arrived.key, png);
    await db
        .update(schema.imageUploads)
        .set({
            created: new Date(Date.now() - 2 * 60 * 60 * 1000),
            nextCheck: new Date(0),
        })
        .where(eq(schema.imageUploads.photoId, ApiValidation.uuid.parse(id)))
        .execute();
    // Recreate the worker's storage dependency, as happens after a process restart.
    await new ImageUploadWorker({
        db,
        getStorage: () => new ImageStorage(new S3Storage(s3)),
        reportError,
    }).check();
    expect((await status(arrived)).status).toBe("completed");
    expect(await status(abandoned)).toMatchObject({
        status: "failed",
        error: "Original image was not uploaded within one hour",
    });
});

test.each([
    [
        2400,
        1200,
        [
            [1920, 960],
            [640, 320],
        ],
    ],
    [
        1200,
        2400,
        [
            [960, 1920],
            [320, 640],
        ],
    ],
    [
        1920,
        1920,
        [
            [1920, 1920],
            [960, 960],
            [320, 320],
        ],
    ],
    [200, 100, []],
] satisfies [number, number, number[][]][])(
    "generates only qualifying variants for %s x %s originals",
    async (width, height, expected) => {
        const { id } = await photo();
        const upload = await initiate(id);
        objects.set(
            upload.key,
            await sharp({
                create: { width, height, channels: 3, background: "red" },
            })
                .png()
                .toBuffer(),
        );
        const result = await process(id, upload.uploadId);
        expect(
            result.assets.map((asset) => [asset.width, asset.height]),
        ).toEqual(expected);
        expect(
            result.assets.map((asset) => asset.assetLocation.split("-").at(-1)),
        ).toEqual(
            expected.map(([w, h]) =>
                Math.min(w!, h!) === 1920
                    ? "large.webp"
                    : Math.min(w!, h!) === 960
                      ? "medium.webp"
                      : "thumbnail.webp",
            ),
        );
        for (const asset of result.assets) {
            const metadata = await sharp(
                objects.get(`images/${id}/${asset.assetLocation}`)!,
            ).metadata();
            expect([metadata.width, metadata.height]).toEqual([
                asset.width,
                asset.height,
            ]);
        }
    },
);

function control(url: string, method: string, body: object) {
    return requestAsUser(app, url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

test("a client with the token can process immediately and repeated requests are safe", async () => {
    const { id } = await photo();
    const upload = await initiate(id);
    objects.set(upload.key, png);
    const first = await control(upload.completeUrl, "POST", {
        token: upload.token,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
        status: "completed",
        id: upload.uploadId,
    });
    const before = [...objects.keys()];
    await due(upload.uploadId);
    await check();
    const repeated = await control(upload.completeUrl, "POST", {
        token: upload.token,
    });
    expect(repeated.status).toBe(200);
    expect([...objects.keys()]).toEqual(before);
    expect(
        (await control(upload.cancelUrl, "POST", { token: upload.token }))
            .status,
    ).toBe(409);
});

test("completion with a missing original leaves the upload pending", async () => {
    const { id } = await photo();
    const upload = await initiate(id);
    const response = await control(upload.completeUrl, "POST", {
        token: upload.token,
    });
    expect(response.status).toBe(404);
    expect((await status(upload)).status).toBe("pending");
    objects.set(upload.key, png);
    const completed = await control(upload.completeUrl, "POST", {
        token: upload.token,
    });
    expect(completed.status).toBe(200);
    expect((await status(upload)).status).toBe("completed");
});

test("explicit cancellation is idempotent and invalid or cross-upload tokens cannot mutate jobs", async () => {
    const { id } = await photo();
    const upload = await initiate(id);
    const another = await initiate(id);
    expect(upload.token).not.toBe(another.token);
    expect((await status(upload)) as object).not.toHaveProperty("token");
    const [receipt] = await db
        .select()
        .from(schema.imageUploads)
        .where(
            eq(
                schema.imageUploads.id,
                ApiValidation.uuid.parse(upload.uploadId),
            ),
        )
        .execute();
    expect(receipt!.tokenHash).not.toBe(upload.token);
    for (const token of ["0".repeat(64), another.token]) {
        expect(
            (await control(upload.completeUrl, "POST", { token })).status,
        ).toBe(403);
        expect(
            (await control(upload.cancelUrl, "POST", { token })).status,
        ).toBe(403);
        expect((await status(upload)).status).toBe("pending");
    }
    expect((await control(upload.cancelUrl, "POST", {})).status).toBe(400);
    expect(
        (await control(upload.cancelUrl, "POST", { token: upload.token }))
            .status,
    ).toBe(200);
    expect(
        (await control(upload.cancelUrl, "POST", { token: upload.token }))
            .status,
    ).toBe(200);
    expect((await status(upload)).status).toBe("cancelled");
});

test("cancelling an active worker discards generated files and preserves the current photo", async () => {
    const { id } = await photo();
    const previous = await initiate(id);
    objects.set(previous.key, png);
    const saved = await process(id, previous.uploadId);
    const upload = await initiate(id);
    objects.set(upload.key, png);
    const before = [...objects.keys()];
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalWrite = s3.write;
    s3.write = async (key, data, options) => {
        const bytes = await originalWrite(key, data, options);
        if (key.startsWith(`images/${id}/`)) {
            reached.resolve();
            await release.promise;
        }
        return bytes;
    };
    await due(upload.uploadId);
    const running = check();
    try {
        await reached.promise;
        const response = await control(upload.cancelUrl, "POST", {
            token: upload.token,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: "cancelled" });
    } finally {
        release.resolve();
        await running;
        s3.write = originalWrite;
    }
    expect([...objects.keys()]).toEqual(before);
    expect(await PhotoApi.read(db, ApiValidation.uuid.parse(id))).toEqual(
        saved,
    );
    expect((await status(upload)).status).toBe("cancelled");
});

test("upload retries persist exponential delays and stop at the configured limit", async () => {
    const { id } = await photo();
    const upload = await initiate(id);
    const config = new WorkerConfiguration({
        backoff: { maxRetries: 2 },
        upload: { retryTime: 10_000 },
    });
    const failures: Error[] = [];
    let attempts = 0;
    const failingStorage = new ImageStorage(
        new S3Storage({
            ...s3,
            file: () => {
                attempts++;
                throw new Error("Temporary storage failure");
            },
        }),
    );
    for (const [attempt, delay] of [10_000, 20_000, undefined].entries()) {
        await due(upload.uploadId);
        const before = Date.now();
        // New instances must resume the persisted retry count.
        await new ImageUploadWorker(
            {
                db,
                getStorage: () => failingStorage,
                reportError: (error) => failures.push(error),
            },
            config,
        ).check();
        const [row] = await db
            .select()
            .from(schema.imageUploads)
            .where(
                eq(
                    schema.imageUploads.id,
                    ApiValidation.uuid.parse(upload.uploadId),
                ),
            );
        expect(row!.retryCount).toBe(Math.min(attempt + 1, 2));
        if (delay !== undefined) {
            expect(row!.failed).toBeNull();
            expect(row!.nextCheck.getTime()).toBeGreaterThanOrEqual(
                before + delay,
            );
            expect(row!.nextCheck.getTime()).toBeLessThanOrEqual(
                Date.now() + delay,
            );
        } else expect(row!.failed).toContain("retry limit");
    }
    await due(upload.uploadId);
    await new ImageUploadWorker(
        {
            db,
            getStorage: () => failingStorage,
            reportError: (error) => failures.push(error),
        },
        config,
    ).check();
    expect(attempts).toBe(3);
    expect(failures).toHaveLength(3);
    expect((await status(upload)).status).toBe("failed");
});

test("waiting for an original does not consume the processing retry budget", async () => {
    const { id } = await photo();
    const upload = await initiate(id);
    for (let attempt = 0; attempt < 3; attempt++) {
        await due(upload.uploadId);
        await new ImageUploadWorker(
            { db, getStorage: () => storage, reportError },
            new WorkerConfiguration({ backoff: { maxRetries: 0 } }),
        ).check();
    }
    const [row] = await db
        .select()
        .from(schema.imageUploads)
        .where(
            eq(
                schema.imageUploads.id,
                ApiValidation.uuid.parse(upload.uploadId),
            ),
        );
    expect(row).toMatchObject({ retryCount: 0, failed: null });
    objects.set(upload.key, png);
    await due(upload.uploadId);
    await check();
    expect((await status(upload)).status).toBe("completed");
});

test("GC persists increasing delays and excludes exhausted jobs", async () => {
    const { id } = await photo();
    const location = "original.webp";
    await db.insert(schema.imageAssetGarbage).values({
        photoId: ApiValidation.uuid.parse(id),
        assetLocation: location,
        nextCheck: new Date(0),
    });
    const config = new WorkerConfiguration({
        backoff: { maxRetries: 2 },
        upload: { retryTime: 10_000 },
    });
    const failures: Error[] = [];
    let attempts = 0;
    const failingStorage = new ImageStorage(
        new S3Storage({
            ...s3,
            delete: async () => {
                attempts++;
                throw new Error("Storage unavailable");
            },
        }),
    );
    for (const [attempt, delay] of [10_000, 20_000, undefined].entries()) {
        await garbageDue(id);
        const before = Date.now();
        await new ImageGarbageCollector(
            {
                db,
                getStorage: () => failingStorage,
                reportError: (error) => failures.push(error),
            },
            config,
        ).collect();
        const [row] = await garbageFor(id);
        expect(row!.retryCount).toBe(Math.min(attempt + 1, 2));
        if (delay !== undefined) {
            expect(row!.failed).toBeNull();
            expect(row!.nextCheck.getTime()).toBeGreaterThanOrEqual(
                before + delay,
            );
            expect(row!.nextCheck.getTime()).toBeLessThanOrEqual(
                Date.now() + delay,
            );
        } else expect(row!.failed).toContain("retry limit");
    }
    await garbageDue(id);
    await new ImageGarbageCollector(
        {
            db,
            getStorage: () => failingStorage,
            reportError: (error) => failures.push(error),
        },
        config,
    ).collect();
    expect(attempts).toBe(3);
    expect(failures).toHaveLength(3);
});
