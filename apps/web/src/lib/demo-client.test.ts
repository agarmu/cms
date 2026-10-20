import { expect, test } from "bun:test";
import { ApiError, photoSchema, type NewPhoto } from "./cms-client";
import { DemoClient } from "./demo-client";
import { demoFixture } from "./demo-test-fixtures";

const image = () =>
    new File(["local image"], "test.png", { type: "image/png" });
const client = () =>
    new DemoClient(demoFixture().reader, async () => ({
        width: 1200,
        height: 800,
    }));
const metadata: NewPhoto = {
    takenAt: "2026-10-20T12:00:00Z",
    postedAt: "2026-10-20T13:00:00Z",
    caption: "My demo photo",
    description: "A **local** upload",
    altText: "Test image",
    location: null,
    visible: false,
    camera: { create: { name: "New demo camera" } },
    lens: null,
};

test("demo reads API metadata, fetches images on demand, and keeps edits local", async () => {
    const { reader, requests } = demoFixture();
    const demo = new DemoClient(reader, async () => ({
        width: 1200,
        height: 800,
    }));
    const first = await demo.listPhotos(0, 25);
    const second = await demo.listPhotos(24, 25);
    expect(first.items).toHaveLength(25);
    expect(second.items).toHaveLength(6);
    expect(first.items[24]?.id).toBe(second.items[0]?.id);
    const all = [...first.items.slice(0, 24), ...second.items];
    expect(new Set(all.map((photo) => photo.id)).size).toBe(30);
    expect(all.some((photo) => !photo.visible)).toBe(true);
    expect(requests).toHaveLength(3);
    expect(
        requests.every((request) => !request.path.includes("/assets/")),
    ).toBe(true);
    for (const photo of all) {
        expect(photoSchema.parse(await demo.readPhoto(photo.id))).toEqual(
            photo,
        );
        for (const asset of photo.assets) {
            const source = await demo.readImage(asset.url);
            expect(source.kind).toBe("blob");
            if (source.kind === "blob")
                expect(source.blob.type).toBe("image/webp");
        }
    }
    const readsBeforeEdits = requests.length;
    const upload = await demo.preparePhotoUpload(image());
    const { id } = await demo.createPhoto(upload, metadata);
    const photo = await demo.updatePhoto(id, { caption: "Edited locally" });
    expect(photo.caption).toBe("Edited locally");
    expect(await demo.readImage(photo.assets[0]!.url)).toEqual({
        kind: "blob",
        blob: image(),
    });
    expect(requests).toHaveLength(readsBeforeEdits);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
});

test("edits and shared equipment changes stay isolated, with reloads restoring the seed", async () => {
    const demo = client();
    const original = (await demo.listPhotos(0, 1)).items[0]!;
    const camera = (await demo.listEquipment("camera"))[0]!;
    const updated = await demo.updatePhoto(original.id, {
        caption: "Changed caption",
        visible: !original.visible,
        camera: { id: camera.id },
        lens: { create: { name: "  A new lens  " } },
    });
    expect(updated.lens?.name).toBe("A new lens");
    expect(await demo.listEquipment("lens")).toContainEqual(updated.lens!);
    await demo.renameEquipment("camera", camera.id, "Renamed camera");
    expect((await demo.readPhoto(original.id)).camera?.name).toBe(
        "Renamed camera",
    );
    updated.caption = "Mutating a returned snapshot";
    expect((await demo.readPhoto(original.id)).caption).toBe("Changed caption");
    demo.clearCache();
    expect((await demo.readPhoto(original.id)).caption).toBe("Changed caption");
    const reloaded = client();
    expect(await reloaded.readPhoto(original.id)).toEqual(original);
    expect(await reloaded.listEquipment("lens")).toHaveLength(2);
});

test("photo uploads support retry, cancellation, creation, and replacement locally", async () => {
    const demo = client();
    const phases: string[] = [];
    const upload = await demo.preparePhotoUpload(image(), undefined, (phase) =>
        phases.push(phase),
    );
    expect(phases).toEqual(["uploading", "processing"]);
    const created = await demo.createPhoto(upload, metadata);
    expect(await demo.createPhoto(upload, metadata)).toEqual(created);
    expect(
        await demo
            .createPhoto(upload, { ...metadata, caption: "different" })
            .catch((e: ApiError) => e.status),
    ).toBe(409);
    expect((await demo.listPhotos(0, 100)).items).toHaveLength(31);
    expect((await demo.listPhotos(0, 1)).items[0]?.id).toBe(created.id);
    const photo = await demo.readPhoto(created.id);
    expect(photo.camera?.name).toBe("New demo camera");
    await demo.cancelPhotoUpload(upload);
    expect((await demo.readImage(photo.assets[0]!.url)).kind).toBe("blob");
    const replacement = new File(["replacement"], "replacement.webp", {
        type: "image/webp",
    });
    const updated = await demo.replaceImage(created.id, replacement);
    expect(updated.assets[0]).toMatchObject({
        filename: replacement.name,
        width: 1200,
        height: 800,
        byteSize: replacement.size,
    });
    expect(await demo.readImage(updated.assets[0]!.url)).toEqual({
        kind: "blob",
        blob: replacement,
    });
    expect(
        await demo
            .readImage(photo.assets[0]!.url)
            .catch((e: ApiError) => e.status),
    ).toBe(404);
    const cancelled = await demo.preparePhotoUpload(image());
    await demo.cancelPhotoUpload(cancelled);
    expect(
        await demo
            .createPhoto(cancelled, metadata)
            .catch((e: ApiError) => e.status),
    ).toBe(404);
    expect((await demo.listPhotos(0, 100)).items).toHaveLength(31);
});

test("aborted uploads and invalid metadata leave the demo unchanged", async () => {
    const controller = new AbortController();
    const demo = new DemoClient(demoFixture().reader, async () => {
        controller.abort();
        return { width: 1200, height: 800 };
    });
    expect(
        await demo
            .preparePhotoUpload(image(), controller.signal)
            .catch((e: Error) => e.name),
    ).toBe("AbortError");
    const photo = (await demo.listPhotos(0, 1)).items[0]!;
    await demo
        .updatePhoto(photo.id, {
            caption: "Should not save",
            camera: { create: { name: "Should not create" } },
            lens: { id: "99999999-0000-4000-8000-000000000000" },
        })
        .catch((e: ApiError) => expect(e.status).toBe(404));
    expect(await demo.readPhoto(photo.id)).toEqual(photo);
    expect(await demo.listEquipment("camera")).toHaveLength(2);
    expect(
        await demo
            .readPhoto("99999999-0000-4000-8000-000000000000")
            .catch((e: ApiError) => e.status),
    ).toBe(404);
    expect(
        await demo
            .readImage("https://cms.example.com/api/photos")
            .catch((e: ApiError) => e.status),
    ).toBe(404);
});

test("demo metadata loads once across callers, supports multiple pages, and keeps aborts local", async () => {
    const fixture = demoFixture(105);
    const demo = new DemoClient(fixture.reader);
    const controller = new AbortController();
    const abandoned = demo.listPhotos(0, 25, controller.signal);
    controller.abort();
    const results = await Promise.allSettled([
        abandoned,
        demo.listPhotos(100, 25),
    ]);
    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("fulfilled");
    if (results[1]?.status === "fulfilled")
        expect(results[1].value.items).toHaveLength(5);
    expect(
        fixture.requests.filter(
            (request) => request.path === "/api/demo/photos",
        ),
    ).toHaveLength(2);
    expect(
        fixture.requests.some((request) => request.path.includes("/assets/")),
    ).toBe(false);
});

test("failed demo startup can be retried without duplicating the snapshot", async () => {
    const fixture = demoFixture();
    let fail = true;
    const demo = new DemoClient({
        ...fixture.reader,
        clearCache: () => fixture.reader.clearCache(),
        readImage: (path, signal) => fixture.reader.readImage(path, signal),
        listEquipment: (kind, signal) =>
            fixture.reader.listEquipment(kind, signal),
        listPhotos: (...args) => {
            if (fail) {
                fail = false;
                return Promise.reject(new Error("Temporary API failure"));
            }
            return fixture.reader.listPhotos(...args);
        },
    });
    expect(
        await demo.listPhotos(0, 25).catch((error: Error) => error.message),
    ).toBe("Temporary API failure");
    expect((await demo.listPhotos(0, 100)).items).toHaveLength(30);
    expect(await demo.listEquipment("camera")).toHaveLength(2);
});
