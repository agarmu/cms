import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { UUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { Scope } from "../api/scope";
import { PhotoApi } from "../api/photos";
import { ImageUploadApi } from "../api/image-uploads";
import { testAuthIdentity } from "../auth/test-fixtures";
import type { AuthIdentity } from "../auth/provider";
import { DatabaseSchema as schema } from "../db/schema";
import { ImageStorage } from "../services/image-storage";
import type { BlobStorage } from "../services/blob-storage";
import { ImageUploadWorker } from "../services/image-upload-worker";
import { ImageGarbageCollector } from "../services/image-garbage-collector";
import { WorkerConfiguration } from "../services/worker-config";
import { HttpApplication } from "./app";

const client = new PGlite();
const db = drizzle(client, { schema: schema.definition });
const objects = new Map<string, Blob>();
const blobs: BlobStorage = {
    createUpload: async (key, contentType) => ({
        url: `https://storage.example/${key}`,
        method: "PUT",
        headers: { "Content-Type": contentType },
    }),
    get: async (key) => objects.get(key),
    read: async (key) =>
        objects.has(key) ? { file: objects.get(key)! } : undefined,
    write: async (key, data, type) => {
        objects.set(key, new Blob([data], { type }));
    },
    delete: async (key) => {
        objects.delete(key);
    },
};
const storage = new ImageStorage(blobs);
const identities: Record<string, AuthIdentity> = {
    admin: testAuthIdentity,
    creator: { ...testAuthIdentity, scopes: new Set([Scope.PhotosCreate]) },
    other: {
        ...testAuthIdentity,
        subject: "another-user",
        scopes: new Set([Scope.PhotosCreate]),
    },
    otherIssuer: {
        ...testAuthIdentity,
        issuer: "https://another-issuer.example",
        scopes: new Set([Scope.PhotosCreate]),
    },
    text: { ...testAuthIdentity, scopes: new Set([Scope.PhotosTextUpdate]) },
    metadata: {
        ...testAuthIdentity,
        scopes: new Set([Scope.PhotosMetadataUpdate]),
    },
    both: {
        ...testAuthIdentity,
        scopes: new Set([Scope.PhotosTextUpdate, Scope.PhotosMetadataUpdate]),
    },
    assets: { ...testAuthIdentity, scopes: new Set([Scope.PhotosAssetsWrite]) },
    reader: { ...testAuthIdentity, scopes: new Set([Scope.PhotosRead]) },
};
const errors: Error[] = [];
const options = {
    db,
    getStorage: () => storage,
    reportError: (error: Error) => errors.push(error),
};
const app = new HttpApplication({
    db,
    getImageStorage: () => storage,
    reportError: options.reportError,
    authentication: { authenticate: async (token) => identities[token]! },
    allowedSubjects: [testAuthIdentity.subject, "another-user"],
});
const metadata = {
    taken: "2026-10-02T12:00:00Z",
    posted: "2026-10-02T12:00:00Z",
    alt: "Photo",
    description: "Description",
    enabled: true,
};
const png = new Blob([
    await sharp({
        create: { width: 200, height: 100, channels: 3, background: "red" },
    })
        .png()
        .toBuffer(),
]);
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

function request(token: string, path: string, method = "GET", body?: object) {
    return app.request(path, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
}
async function start(token = "creator") {
    const response = await request(token, "/api/photo-uploads", "POST", {
        contentType: "image/png",
    });
    expect(response.status).toBe(201);
    const upload = (await response.json()) as {
        id: UUID;
        upload: { url: string };
        expiresAt: string;
    };
    expect(upload).not.toHaveProperty("token");
    const path = response.headers.get("Location")!;
    return {
        ...upload,
        path,
        key: new URL(upload.upload.url).pathname.slice(1),
    };
}
async function prepare() {
    const upload = await start();
    objects.set(upload.key, png);
    const response = await request(
        "creator",
        `${upload.path}/complete`,
        "POST",
    );
    expect(response.status).toBe(200);
    const status = (await response.json()) as {
        assets: {
            url: string;
            filename: string;
            width: number;
            height: number;
        }[];
    };
    expect(status).toMatchObject({
        status: "ready",
        completedAt: null,
        processedAt: expect.any(String),
    });
    return { ...upload, assets: status.assets };
}
const save = (id: UUID, extra: object = {}, token = "creator") =>
    request(token, "/api/photos", "POST", {
        ...metadata,
        uploadId: id,
        ...extra,
    });
const expire = (id: UUID) =>
    db
        .update(schema.imageUploads)
        .set({ expires: new Date(0), nextCheck: new Date(0) })
        .where(eq(schema.imageUploads.id, id));
const collect = () => new ImageGarbageCollector(options).collect();

test("a creator prepares an image, previews it, and saves metadata and equipment atomically", async () => {
    const before = await db.query.images.findMany();
    const upload = await prepare();
    expect(await db.query.images.findMany()).toEqual(before);
    expect(upload.assets).toMatchObject([{ width: 200, height: 100 }]);
    const preview = await request("creator", upload.assets[0]!.url);
    expect(preview.status).toBe(200);
    expect((await sharp(await preview.arrayBuffer()).metadata()).width).toBe(
        200,
    );
    const response = await save(upload.id, {
        camera: { create: { name: "New camera" } },
        lens: { create: { name: "New lens" } },
    });
    expect(response.status).toBe(201);
    const photo = (await response.json()) as { id: UUID };
    expect(Object.keys(photo)).toEqual(["id"]);
    expect(response.headers.get("Location")).toBe(`/api/photos/${photo.id}`);
    const saved = await PhotoApi.read(db, photo.id);
    expect(saved).toMatchObject({
        alt: "Photo",
        camera: { name: "New camera" },
        lens: { name: "New lens" },
        assets: [{ width: 200, height: 100 }],
    });
    for (const path of [
        `/api/photos/${photo.id}/image`,
        `/api/photos/${photo.id}/assets/${saved.assets[0]!.assetLocation}`,
    ]) {
        const downloaded = await request("reader", path);
        expect(downloaded.status).toBe(200);
        expect(downloaded.headers.get("Content-Type")).toBe("image/webp");
        expect(downloaded.headers.get("Cache-Control")).toBe(
            "private, no-store",
        );
        expect(
            (await sharp(await downloaded.arrayBuffer()).metadata()).width,
        ).toBe(200);
    }
    expect((await request("creator", upload.assets[0]!.url)).status).toBe(404);
    expect((await request("creator", `/api/photos/${photo.id}`)).status).toBe(
        403,
    );
    expect(
        (
            await request("creator", `/api/photos/${photo.id}`, "PATCH", {
                alt: "Changed",
            })
        ).status,
    ).toBe(403);
    expect(
        (
            await request(
                "creator",
                `/api/photos/${photo.id}/uploads`,
                "POST",
                {
                    contentType: "image/png",
                },
            )
        ).status,
    ).toBe(403);
    expect(
        (await request("creator", `/api/cameras/${saved.camera!.id}`, "DELETE"))
            .status,
    ).toBe(403);
    expect(
        (await request("creator", `/api/photos/${photo.id}`, "DELETE")).status,
    ).toBe(403);
    const next = await prepare();
    const linked = await save(next.id, {
        camera: { id: saved.camera!.id },
        lens: { id: saved.lens!.id },
    });
    expect(linked.status).toBe(201);
    expect(await db.query.cameras.findMany()).toHaveLength(1);
});

test("upload ownership includes issuer and subject on every operation", async () => {
    const upload = await prepare();
    for (const token of ["other", "otherIssuer"]) {
        expect((await request(token, upload.path)).status).toBe(403);
        expect((await request(token, upload.assets[0]!.url)).status).toBe(403);
        expect(
            (await request(token, `${upload.path}/complete`, "POST")).status,
        ).toBe(403);
        expect(
            (await request(token, `${upload.path}/cancel`, "POST")).status,
        ).toBe(403);
        expect((await save(upload.id, {}, token)).status).toBe(403);
    }
    expect((await request("reader", upload.path)).status).toBe(403);
    expect(
        (
            await request("assets", "/api/photo-uploads", "POST", {
                contentType: "image/png",
            })
        ).status,
    ).toBe(403);
    expect(
        (
            await request("creator", "/api/photo-uploads", "POST", {
                contentType: "image/png",
                photoId: randomUUID(),
            })
        ).status,
    ).toBe(400);
    expect(
        (await save(upload.id, { createdBySubject: "another-user" })).status,
    ).toBe(400);
    expect((await save(upload.id, { assets: [] })).status).toBe(400);
    expect((await save(upload.id)).status).toBe(201);
});

test("creation and replacement sessions cannot be used interchangeably", async () => {
    const upload = await prepare();
    const created = await save(upload.id);
    const { id } = (await created.json()) as { id: UUID };
    const replacement = await request(
        "assets",
        `/api/photos/${id}/uploads`,
        "POST",
        { contentType: "image/png" },
    );
    expect(replacement.status).toBe(201);
    const receipt = (await replacement.json()) as {
        id: UUID;
        upload: { url: string };
    };
    expect(
        (await request("admin", `/api/photo-uploads/${receipt.id}`)).status,
    ).toBe(404);
    expect((await save(receipt.id, {}, "admin")).status).toBe(404);
    expect(
        (
            await request(
                "admin",
                `/api/photos/${id}/uploads/${upload.id}/complete`,
                "POST",
            )
        ).status,
    ).toBe(404);
    const before = await PhotoApi.read(db, id);
    expect(
        (
            await request(
                "assets",
                `/api/photos/${id}/uploads/${receipt.id}/complete`,
                "POST",
            )
        ).status,
    ).toBe(404);
    expect(await PhotoApi.read(db, id)).toEqual(before);
    objects.set(new URL(receipt.upload.url).pathname.slice(1), png);
    expect(
        (
            await request(
                "assets",
                `/api/photos/${id}/uploads/${receipt.id}/complete`,
                "POST",
            )
        ).status,
    ).toBe(200);
    expect((await PhotoApi.read(db, id)).assets).not.toEqual(before.assets);
});

test("text and metadata scopes are independent and mixed patches cannot partially apply", async () => {
    const response = await save((await prepare()).id);
    const { id } = (await response.json()) as { id: UUID };
    const path = `/api/photos/${id}`;
    expect(
        (
            await request("text", path, "PATCH", {
                alt: "Updated",
                description: "Updated description",
            })
        ).status,
    ).toBe(200);
    const before = await PhotoApi.read(db, id);
    for (const patch of [
        { alt: "Must not apply", enabled: false },
        { camera: { create: { name: "Forbidden" } } },
        { taken: metadata.taken },
    ]) {
        expect((await request("text", path, "PATCH", patch)).status).toBe(403);
        expect(await PhotoApi.read(db, id)).toEqual(before);
    }
    expect(
        (await request("metadata", path, "PATCH", { alt: "No" })).status,
    ).toBe(403);
    expect(
        (await request("metadata", path, "PATCH", { enabled: false })).status,
    ).toBe(200);
    expect((await request("assets", path, "PATCH", { alt: "No" })).status).toBe(
        403,
    );
    expect((await request("admin", path, "PATCH", { assets: [] })).status).toBe(
        400,
    );
    expect(
        (await request("both", path, "PATCH", { alt: "Both", enabled: true }))
            .status,
    ).toBe(200);
    expect((await request("text", path, "DELETE")).status).toBe(403);
});

test("concurrent processing and saves consume one session and create equipment once", async () => {
    const upload = await start();
    objects.set(upload.key, png);
    const completed = await Promise.all([
        request("creator", `${upload.path}/complete`, "POST"),
        request("creator", `${upload.path}/complete`, "POST"),
    ]);
    expect(completed.map((response) => response.status)).toEqual([200, 200]);
    expect(
        [...objects.keys()].filter((key) =>
            key.startsWith(`images/${upload.key.split("/")[1]}/`),
        ),
    ).toHaveLength(1);
    const before = await db.query.images.findMany();
    const camerasBefore = await db.query.cameras.findMany();
    const input = { camera: { create: { name: "Created exactly once" } } };
    const responses = await Promise.all([
        save(upload.id, input),
        save(upload.id, input),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const results = await Promise.all(
        responses.map((response) => response.json()),
    );
    expect(results[0]).toEqual(results[1]);
    expect(await db.query.images.findMany()).toHaveLength(before.length + 1);
    expect(await db.query.cameras.findMany()).toHaveLength(
        camerasBefore.length + 1,
    );
    expect((await save(upload.id, { ...input, alt: "Different" })).status).toBe(
        409,
    );
    const { id } = results[0] as { id: UUID };
    await PhotoApi.update(db, id, { description: "Private later edit" });
    await expire(upload.id);
    expect(await (await save(upload.id, input)).json()).toEqual({ id });
    await PhotoApi.remove(db, id);
    expect((await save(upload.id, input)).status).toBe(404);
});

test("failed saves leave the upload reusable and roll back inline equipment", async () => {
    const upload = await prepare();
    const before = await db.query.cameras.findMany();
    const response = await save(upload.id, {
        camera: { create: { name: "Rollback" } },
        lens: { id: randomUUID() },
    });
    expect(response.status).toBe(409);
    expect(await db.query.cameras.findMany()).toEqual(before);
    expect(await (await request("creator", upload.path)).json()).toMatchObject({
        status: "ready",
    });
    expect((await save(upload.id)).status).toBe(201);
});

test("the worker prepares new uploads without creating photos and ignores overwritten ready originals", async () => {
    const upload = await start();
    expect((await save(upload.id)).status).toBe(409);
    objects.set(upload.key, png);
    const before = await db.query.images.findMany();
    await db
        .update(schema.imageUploads)
        .set({ nextCheck: new Date(0) })
        .where(eq(schema.imageUploads.id, upload.id));
    await new ImageUploadWorker(options).check();
    expect(await db.query.images.findMany()).toEqual(before);
    expect(await (await request("creator", upload.path)).json()).toMatchObject({
        status: "ready",
    });
    const keys = [...objects.keys()];
    objects.set(upload.key, new Blob(["invalid replacement"]));
    expect(
        (await request("creator", `${upload.path}/complete`, "POST")).status,
    ).toBe(200);
    expect([...objects.keys()]).toEqual(keys);
    expect((await save(upload.id)).status).toBe(201);
});

test("cancelled and expired sessions cannot create photos and abandoned files are collected", async () => {
    for (const cancel of [true, false]) {
        const upload = await prepare();
        if (cancel) {
            expect(
                (await request("creator", `${upload.path}/cancel`, "POST"))
                    .status,
            ).toBe(200);
            expect(
                (await request("creator", `${upload.path}/cancel`, "POST"))
                    .status,
            ).toBe(200);
        }
        await expire(upload.id);
        expect((await save(upload.id)).status).toBe(409);
        expect(
            (await request("creator", `${upload.path}/complete`, "POST"))
                .status,
        ).toBe(409);
        await new ImageUploadWorker(options).check();
        await collect();
        expect(objects.has(upload.key)).toBe(false);
        const photoId = upload.key.split("/")[1]!;
        expect(
            [...objects.keys()].filter((key) =>
                key.startsWith(`images/${photoId}/`),
            ),
        ).toEqual([]);
    }
    const used = await prepare();
    const { id } = (await (await save(used.id)).json()) as { id: UUID };
    await expire(used.id);
    await new ImageUploadWorker(options).check();
    await collect();
    expect(objects.has(used.key)).toBe(false);
    expect(
        [...objects.keys()].filter((key) => key.startsWith(`images/${id}/`)),
    ).toHaveLength(1);
    expect((await save(used.id)).status).toBe(201);
});

test("expiration cleanup backs off failures without starving later sessions", async () => {
    const first = await start();
    const second = await start();
    for (const upload of [first, second]) {
        objects.set(upload.key, png);
        await expire(upload.id);
    }
    const failure = new Error("Temporary deletion failure");
    const cleanupErrors: Error[] = [];
    const faultyStorage = new ImageStorage({
        ...blobs,
        delete: async (key) => {
            if (key === first.key) throw failure;
            await blobs.delete(key);
        },
    });
    await db
        .update(schema.imageUploads)
        .set({ nextCheck: new Date(1) })
        .where(eq(schema.imageUploads.id, second.id));
    const worker = new ImageUploadWorker(
        {
            db,
            getStorage: () => faultyStorage,
            reportError: (error) => cleanupErrors.push(error),
        },
        new WorkerConfiguration({ batchSize: 1 }),
    );
    await worker.check();
    expect(cleanupErrors).toEqual([failure]);
    await worker.check();
    expect(objects.has(first.key)).toBe(true);
    expect(objects.has(second.key)).toBe(false);
    await expire(first.id);
    await new ImageUploadWorker(options).check();
    expect(objects.has(first.key)).toBe(false);
});

test("cancelling a creation during processing discards its generated files", async () => {
    const upload = await start();
    objects.set(upload.key, png);
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delayed = new ImageStorage({
        ...blobs,
        write: async (key, data, type) => {
            await blobs.write(key, data, type);
            reached.resolve();
            await release.promise;
        },
    });
    const processing = ImageUploadApi.complete(db, delayed, upload.id).catch(
        (error: unknown) => error,
    );
    await reached.promise;
    try {
        expect(
            (await request("creator", `${upload.path}/cancel`, "POST")).status,
        ).toBe(200);
    } finally {
        release.resolve();
    }
    expect(await processing).toMatchObject({
        message: "Upload has been cancelled",
    });
    expect(
        [...objects.keys()].filter((key) =>
            key.startsWith(`images/${upload.key.split("/")[1]}/`),
        ),
    ).toEqual([]);
    expect((await save(upload.id)).status).toBe(409);
});
