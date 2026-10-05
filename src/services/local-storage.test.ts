import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { BlobStorage } from "./blob-storage";
import { ImageStorage, MissingOriginalError } from "./image-storage";
import { LocalStorage } from "./local-storage";

let directory: string;
let storage: BlobStorage;
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cms-blobs-"));
    storage = new LocalStorage(directory);
});
afterEach(() => rm(directory, { recursive: true, force: true }));

test("local blob storage reads, streams, overwrites, and deletes non-image content", async () => {
    const key = "documents/notes.txt";
    expect(await storage.get(key)).toBeUndefined();
    expect(await storage.read(key, 3600)).toBeUndefined();
    const data = new TextEncoder().encode("hello blobs");
    await storage.write(key, data, "text/plain");
    const blob = await storage.get(key);
    expect(blob!.size).toBe(data.length);
    expect(await new Response(blob!.stream()).text()).toBe("hello blobs");
    const download = await storage.read(key, 3600);
    if (!download || !("file" in download))
        throw new Error("Expected a local file");
    expect(await download.file.text()).toBe("hello blobs");
    expect(download.file.type).toStartWith("text/plain");
    await storage.write(key, new TextEncoder().encode("updated"), "text/plain");
    expect(await new Response((await storage.get(key))!.stream()).text()).toBe(
        "updated",
    );
    await storage.delete(key);
    await storage.delete(key);
    expect(await storage.get(key)).toBeUndefined();
});

test("image processing and cleanup work with a non-S3 blob backend", async () => {
    const images = new ImageStorage(storage);
    const photoId = crypto.randomUUID();
    const uploadId = crypto.randomUUID();
    await expect(
        images.createUpload(photoId, uploadId, "image/png"),
    ).rejects.toThrow("Storage does not support direct uploads");
    await expect(
        images.processUpload(photoId, uploadId),
    ).rejects.toBeInstanceOf(MissingOriginalError);
    const original = await sharp({
        create: { width: 640, height: 320, channels: 3, background: "red" },
    })
        .png()
        .toBuffer();
    const originalKey = `originals/${photoId}/${uploadId}`;
    await storage.write(originalKey, original, "image/png");
    const processed = await images.processUpload(photoId, uploadId);
    expect(processed.assets).toHaveLength(1);
    const asset = processed.assets[0]!;
    expect([asset.width, asset.height]).toEqual([640, 320]);
    const download = await images.read(photoId, asset.assetLocation);
    if (!download || !("file" in download))
        throw new Error("Expected a local image");
    expect(download.file.type).toBe("image/webp");
    expect(
        (await sharp(await download.file.arrayBuffer()).metadata()).format,
    ).toBe("webp");
    await images.deleteAsset(photoId, asset.assetLocation);
    await processed.cleanup();
    expect(await images.read(photoId, asset.assetLocation)).toBeUndefined();
    expect((await storage.get(originalKey))!.size).toBe(original.length);
});

test("local blob keys cannot escape the storage directory", async () => {
    for (const key of [
        "../outside.txt",
        "/outside.txt",
        "nested/../../outside.txt",
        ".",
    ]) {
        await expect(storage.get(key)).rejects.toThrow(
            "within the storage directory",
        );
        await expect(storage.read(key, 3600)).rejects.toThrow(
            "within the storage directory",
        );
        await expect(
            storage.write(key, new Uint8Array(), "text/plain"),
        ).rejects.toThrow("within the storage directory");
        await expect(storage.delete(key)).rejects.toThrow(
            "within the storage directory",
        );
    }
});
