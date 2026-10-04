import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import sharp from "sharp";
import * as schema from "../db/schema";
import { ImageUploadApi } from "../api/image-uploads";
import { uuid } from "../api/validation";
import { ImageStorage, maxImageBytes } from "../services/image-storage";
import type { ImageS3Client } from "../services/image-storage";
import { checkImageUploads } from "../services/image-upload-worker";
import { createApp } from "./app";

const client = new PGlite();
const db = drizzle(client, { schema });
const objects = new Map<string, Uint8Array>();
const signer = new Bun.S3Client({
    bucket: "photos",
    region: "us-east-1",
    accessKeyId: "test-key",
    secretAccessKey: "test-secret",
});
const s3: ImageS3Client = {
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
const storage = new ImageStorage({ client: s3 });
const reportError = (error: Error) => errors.push(error);
const app = createApp({ db, imageStorage: storage, reportError });
const check = () =>
    checkImageUploads({ db, getStorage: () => storage, reportError });
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
    const response = await app.request("/images", {
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
    const response = await app.request(`/images/${id}/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"contentType":"image/png"}',
    });
    expect(response.status).toBe(201);
    return (await response.json()) as {
        uploadId: string;
        key: string;
        url: string;
        method: string;
        headers: Record<string, string>;
        statusUrl: string;
        token: string;
        interruptUrl: string;
        cancelUrl: string;
    };
}
const status = async (upload: { statusUrl: string }) =>
    (await (await app.request(upload.statusUrl)).json()) as {
        status: string;
        error: string | null;
    };
const due = (uploadId: string) =>
    db
        .update(schema.imageUploads)
        .set({ nextCheck: new Date(0) })
        .where(eq(schema.imageUploads.id, uuid.parse(uploadId)))
        .execute();
const process = (id: string, uploadId: string) =>
    ImageUploadApi.complete(db, storage, uuid.parse(id), uuid.parse(uploadId));
const png = await sharp({
    create: { width: 1000, height: 500, channels: 3, background: "red" },
})
    .png()
    .toBuffer();

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
        .where(eq(schema.imageUploads.id, uuid.parse(upload.uploadId)))
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
        await app.request(`/images/${id}/metadata`)
    ).json()) as {
        assets: { assetLocation: string; width: number; height: number }[];
    };
    expect(result.assets.map(({ width, height }) => [width, height])).toEqual([
        [640, 320],
    ]);
    expect(objects.get(upload.key)).toEqual(png);
    expect(
        [...objects.keys()].filter((key) => key.startsWith(`images/${id}/`)),
    ).toHaveLength(1);
    const redirect = await app.request(`/images/${id}`);
    const download = await app.request(redirect.headers.get("Location")!);
    expect(download.status).toBe(302);
    const largest = objects.get(
        `images/${id}/${result.assets[0]!.assetLocation}`,
    )!;
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

test("invalid and oversized originals fail without changing photo assets", async () => {
    const { id } = await photo();
    for (const bytes of [
        new Uint8Array(),
        new TextEncoder().encode("broken"),
        new Uint8Array(maxImageBytes + 1),
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
        (await app.request(`/images/${second.id}/uploads/${upload.uploadId}`))
            .status,
    ).toBe(404);
    expect(
        (
            await app.request(
                `/images/${first.id}/uploads/${crypto.randomUUID()}`,
            )
        ).status,
    ).toBe(404);
    expect(
        (await app.request(`/images/${first.id}/uploads/invalid`)).status,
    ).toBe(400);
    const form = new FormData();
    form.set("file", new File([png], "photo.png"));
    expect(
        (
            await app.request(`/images/${first.id}/upload`, {
                method: "POST",
                body: form,
            })
        ).status,
    ).toBe(400);
    expect(
        (
            await app.request(`/images/${first.id}/upload`, {
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
            .where(eq(schema.imageUploads.id, uuid.parse(upload.uploadId)))
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
        .where(eq(schema.imageUploads.photoId, uuid.parse(id)))
        .execute();
    // Recreate the worker's storage dependency, as happens after a process restart.
    await checkImageUploads({
        db,
        getStorage: () => new ImageStorage({ client: s3 }),
        reportError,
    });
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
    return app.request(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

test("a client with the token can process immediately and repeated requests are safe", async () => {
    const { id } = await photo();
    const upload = await initiate(id);
    objects.set(upload.key, png);
    const first = await control(upload.interruptUrl, "POST", {
        token: upload.token,
        ready: true,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
        status: "completed",
        photo: { id },
    });
    const before = [...objects.keys()];
    await due(upload.uploadId);
    await check();
    const repeated = await control(upload.interruptUrl, "POST", {
        token: upload.token,
        ready: true,
    });
    expect(repeated.status).toBe(200);
    expect([...objects.keys()]).toEqual(before);
    expect(
        (await control(upload.cancelUrl, "DELETE", { token: upload.token }))
            .status,
    ).toBe(409);
});

test("an interrupt cancels when the client is not ready or the original is missing", async () => {
    const { id } = await photo();
    for (const ready of [false, true]) {
        const upload = await initiate(id);
        const response = await control(upload.interruptUrl, "POST", {
            token: upload.token,
            ready,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: "cancelled" });
        objects.set(upload.key, png);
        await due(upload.uploadId);
        await check();
        expect((await status(upload)).status).toBe("cancelled");
    }
    expect(
        [...objects.keys()].filter((key) => key.startsWith(`images/${id}/`)),
    ).toHaveLength(0);
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
        .where(eq(schema.imageUploads.id, uuid.parse(upload.uploadId)))
        .execute();
    expect(receipt!.tokenHash).not.toBe(upload.token);
    for (const token of ["0".repeat(64), another.token]) {
        expect(
            (await control(upload.interruptUrl, "POST", { token, ready: true }))
                .status,
        ).toBe(403);
        expect(
            (await control(upload.cancelUrl, "DELETE", { token })).status,
        ).toBe(403);
        expect((await status(upload)).status).toBe("pending");
    }
    expect((await control(upload.cancelUrl, "DELETE", {})).status).toBe(400);
    expect(
        (await control(upload.cancelUrl, "DELETE", { token: upload.token }))
            .status,
    ).toBe(200);
    expect(
        (await control(upload.cancelUrl, "DELETE", { token: upload.token }))
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
        const response = await control(upload.cancelUrl, "DELETE", {
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
    expect(await (await app.request(`/images/${id}/metadata`)).json()).toEqual(
        JSON.parse(JSON.stringify(saved)),
    );
    expect((await status(upload)).status).toBe("cancelled");
});
