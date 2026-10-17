/// <reference types="bun" />
import { expect, test } from "bun:test";
import { ApiError, CmsClient, selectAsset } from "./cms-client";

const id = "ee15b804-ef9c-4cc3-89a4-3522c9719923";
const date = "2026-10-11T12:00:00.000Z";
const asset = {
    id: 1,
    filename: "small.webp",
    width: 400,
    height: 300,
    byteSize: 42_000,
    url: `/api/photos/${id}/assets/small.webp`,
};
const photo = {
    id,
    takenAt: date,
    postedAt: date,
    altText: "A photo",
    caption: "",
    description: "",
    location: null,
    visible: true,
    camera: null,
    lens: null,
    assets: [asset],
};

test.each([undefined, null, 3_000_000_000])(
    "photo responses preserve byte counts, including legacy value %s",
    async (byteSize) => {
        const client = new CmsClient(
            "https://cms.example.com/",
            async () => undefined,
            async () =>
                Response.json({ ...photo, assets: [{ ...asset, byteSize }] }),
        );
        expect((await client.readPhoto(id)).assets[0]?.byteSize).toBe(
            byteSize ?? null,
        );
    },
);

test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "photo responses reject invalid byte count %s",
    async (byteSize) => {
        const client = new CmsClient(
            "https://cms.example.com/",
            async () => undefined,
            async () =>
                Response.json({ ...photo, assets: [{ ...asset, byteSize }] }),
        );
        expect(client.readPhoto(id)).rejects.toThrow();
    },
);

test("CMS bearer tokens stay on the configured origin and redirects are refused", async () => {
    const requests: { url: URL; init: RequestInit }[] = [];
    const client = new CmsClient(
        "https://cms.example.com/",
        async () => "cms-token",
        async (url, init) => {
            requests.push({ url, init });
            return Response.json(photo);
        },
    );
    for (const path of [
        "https://evil.example/api/photos",
        "//evil.example/api/photos",
        "/other",
        "https://user:pass@cms.example.com/api/photos",
        "/api/../private",
    ]) {
        await expect(client.request(path)).rejects.toThrow(
            "configured CMS API",
        );
    }
    expect(requests).toHaveLength(0);
    await client.request(`/api/photos/${id}`, {
        credentials: "include",
        redirect: "follow",
        headers: { Authorization: "untrusted-token" },
    });
    expect(requests).toHaveLength(1);
    expect(new Headers(requests[0]!.init.headers).get("Authorization")).toBe(
        "Bearer cms-token",
    );
    expect(requests[0]!.init.credentials).toBe("omit");
    expect(requests[0]!.init.redirect).toBe("error");
});

test("no-auth requests carry no authorization and cancellation reaches fetch", async () => {
    const controller = new AbortController();
    const client = new CmsClient(
        "http://localhost:3000/",
        async () => undefined,
        async (_url, init) => {
            expect(new Headers(init.headers).has("Authorization")).toBe(false);
            expect(init.signal).toBe(controller.signal);
            return Response.json({ items: [photo], offset: 24, limit: 25 });
        },
    );
    const page = await client.listPhotos(24, 25, controller.signal);
    expect(page.items[0]?.id).toBe(id);
});

test("text updates PATCH only the requested fields with CMS credentials and cancellation", async () => {
    const controller = new AbortController();
    const changes = { caption: "  A new caption\n", altText: "" };
    const updated = { ...photo, ...changes };
    const client = new CmsClient(
        "https://cms.example.com/",
        async () => "cms-token",
        async (url, init) => {
            expect(url.href).toBe(`https://cms.example.com/api/photos/${id}`);
            expect(init.method).toBe("PATCH");
            const headers = new Headers(init.headers);
            expect(headers.get("Content-Type")).toBe("application/json");
            expect(headers.get("Authorization")).toBe("Bearer cms-token");
            expect(JSON.parse(init.body as string)).toEqual(changes);
            expect(init.signal).toBe(controller.signal);
            expect(init.credentials).toBe("omit");
            expect(init.redirect).toBe("error");
            return Response.json(updated);
        },
    );
    expect(await client.updatePhoto(id, changes, controller.signal)).toEqual(
        updated,
    );
});

test("text updates reject invalid IDs, empty patches, and non-text fields before making a request", async () => {
    let requests = 0;
    const client = new CmsClient(
        "https://cms.example.com/",
        async () => undefined,
        async () => {
            requests++;
            return Response.json(photo);
        },
    );
    expect(client.updatePhoto("invalid", { altText: "New" })).rejects.toThrow();
    expect(client.updatePhoto(id, {})).rejects.toThrow();
    expect(client.updatePhoto(id, { altText: undefined })).rejects.toThrow();
    expect(
        client.updatePhoto(id, { ...photo, altText: "New" }),
    ).rejects.toThrow();
    expect(requests).toBe(0);
});

test.each([401, 403, 404, 500])(
    "text updates preserve HTTP %i without exposing server details",
    async (status) => {
        const client = new CmsClient(
            "https://cms.example.com/",
            async () => undefined,
            async () =>
                Response.json({ error: "Internal details" }, { status }),
        );
        try {
            await client.updatePhoto(id, { altText: "New" });
            throw new Error("Expected the update to fail");
        } catch (error) {
            expect(error).toBeInstanceOf(ApiError);
            expect((error as ApiError).status).toBe(status);
            expect((error as Error).message).not.toContain("Internal details");
        }
    },
);

test("text updates validate the returned photo before treating the save as successful", async () => {
    const client = new CmsClient(
        "https://cms.example.com/",
        async () => undefined,
        async () => Response.json({ ...photo, caption: null }),
    );
    expect(client.updatePhoto(id, { altText: "New" })).rejects.toThrow();
});

test("local assets become blobs and signed assets do not trigger credentialed storage requests", async () => {
    const blobClient = new CmsClient(
        "https://cms.example.com/",
        async () => "token",
        async () =>
            new Response("image-bytes", {
                headers: { "Content-Type": "image/webp" },
            }),
    );
    const local = await blobClient.readImage(asset.url);
    expect(local.kind).toBe("blob");
    if (local.kind === "blob")
        expect(await local.blob.text()).toBe("image-bytes");

    let requests = 0;
    const signedUrl = "https://bucket.example/photo.webp?signature=temporary";
    const s3Client = new CmsClient(
        "https://cms.example.com/",
        async () => "token",
        async () => {
            requests++;
            return Response.json({ url: signedUrl, expiresAt: date });
        },
    );
    expect(await s3Client.readImage(asset.url)).toEqual({
        kind: "remote",
        url: signedUrl,
    });
    expect(requests).toBe(1);
});

test.each([
    "javascript:alert(1)",
    "data:image/svg+xml,unsafe",
    "http://bucket.example/image.webp",
    "https://user:secret@bucket.example/image.webp",
])("rejects unsafe signed image URL %s", async (url) => {
    const client = new CmsClient(
        "https://cms.example.com/",
        async () => undefined,
        async () => Response.json({ url, expiresAt: date }),
    );
    await expect(client.readImage(asset.url)).rejects.toThrow();
});

test.each([401, 403, 404, 500, 503])(
    "preserves HTTP %i for actionable UI errors",
    async (status) => {
        const client = new CmsClient(
            "https://cms.example.com/",
            async () => undefined,
            async () =>
                Response.json({ error: "Internal details" }, { status }),
        );
        let caught: unknown;
        try {
            await client.readPhoto(id);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ApiError);
        expect((caught as ApiError).status).toBe(status);
        expect((caught as Error).message).not.toContain("Internal details");
    },
);

test("invalid metadata and non-image responses fail instead of rendering malformed content", async () => {
    const client = new CmsClient(
        "https://cms.example.com/",
        async () => undefined,
        async () =>
            Response.json({
                items: [{ ...photo, assets: undefined }],
                offset: 0,
                limit: 25,
            }),
    );
    await expect(client.listPhotos(0, 25)).rejects.toThrow();
    await expect(client.readPhoto("invalid-id")).rejects.toThrow();
    const htmlClient = new CmsClient(
        "https://cms.example.com/",
        async () => undefined,
        async () =>
            new Response("<html>Login</html>", {
                headers: { "Content-Type": "text/html" },
            }),
    );
    await expect(htmlClient.readImage(asset.url)).rejects.toThrow(
        "unsupported image response",
    );
});

test("asset selection uses a suitable resolution without mutating backend order", () => {
    const large = { ...asset, id: 2, width: 1600, height: 1200 };
    const assets = [large, asset];
    expect(selectAsset(assets, 300)).toBe(asset);
    expect(selectAsset(assets, 600)).toBe(large);
    expect(selectAsset(assets, Infinity)).toBe(large);
    expect(selectAsset([], 300)).toBeUndefined();
    expect(assets).toEqual([large, asset]);
});

test("photo metadata updates accept dates, location, visibility, and equipment without unrelated fields", async () => {
    const client = new CmsClient(
        "https://cms.example.com/",
        async () => undefined,
        async (_url, init) => {
            const changes = JSON.parse(init.body as string) as object;
            expect(Object.keys(changes)).toHaveLength(1);
            return Response.json(photo);
        },
    );
    for (const changes of [
        { description: "## A description\n\nWith **Markdown**." },
        { description: "" },
        { location: null },
        { takenAt: date },
        { postedAt: date },
        { visible: false },
        { camera: null },
        { lens: { create: { name: "New lens" } } },
    ])
        await client.updatePhoto(id, changes);
    for (const changes of [
        { description: null },
        { enabled: true },
        { assets: [] },
        { id },
    ])
        expect(client.updatePhoto(id, changes as never)).rejects.toThrow();
});

test("equipment choices include every page and renaming uses its own PATCH endpoint", async () => {
    const equipment = { id, name: "Camera" };
    const requests: string[] = [];
    const client = new CmsClient(
        "https://cms.example.com/",
        async () => undefined,
        async (url, init) => {
            requests.push(url.pathname + url.search);
            if (init.method === "PATCH") {
                expect(JSON.parse(init.body as string)).toEqual({
                    name: "Renamed",
                });
                return Response.json({ ...equipment, name: "Renamed" });
            }
            const offset = Number(url.searchParams.get("offset"));
            return Response.json({
                items:
                    offset === 0
                        ? Array.from({ length: 100 }, () => equipment)
                        : [equipment],
                limit: 100,
                offset,
            });
        },
    );
    expect(await client.listEquipment("camera")).toHaveLength(101);
    expect(requests).toEqual([
        "/api/cameras?offset=0&limit=100",
        "/api/cameras?offset=100&limit=100",
    ]);
    expect(await client.renameEquipment("camera", id, " Renamed ")).toEqual({
        ...equipment,
        name: "Renamed",
    });
});

test("image replacement sends the bearer only to the CMS and uploads bytes without credentials", async () => {
    const calls: string[] = [];
    const file = new File(["image bytes"], "new.png", { type: "image/png" });
    const client = new CmsClient(
        "https://cms.example.com/",
        async () => "cms-token",
        async (url, init) => {
            calls.push(url.pathname);
            expect(new Headers(init.headers).get("Authorization")).toBe(
                "Bearer cms-token",
            );
            if (url.pathname.endsWith("/uploads"))
                return Response.json({
                    id,
                    upload: {
                        url: "https://storage.example.com/original?signature=x",
                        method: "PUT",
                        headers: { "Content-Type": "image/png" },
                    },
                });
            if (url.pathname.endsWith("/complete"))
                return Response.json({ status: "completed" });
            return Response.json(photo);
        },
        async (url, init) => {
            expect(url.hostname).toBe("storage.example.com");
            expect(init.method).toBe("PUT");
            expect(init.body).toBe(file);
            expect(new Headers(init.headers).has("Authorization")).toBe(false);
            expect(init.credentials).toBe("omit");
            expect(init.redirect).toBe("error");
            return new Response(null, { status: 200 });
        },
    );
    expect(await client.replaceImage(id, file)).toEqual(photo);
    expect(calls).toEqual([
        `/api/photos/${id}/uploads`,
        `/api/photos/${id}/uploads/${id}/complete`,
        `/api/photos/${id}`,
    ]);
});

test("a failed image upload cancels the receipt without publishing replacement assets", async () => {
    const paths: string[] = [];
    const client = new CmsClient(
        "https://cms.example.com/",
        async () => undefined,
        async (url) => {
            paths.push(url.pathname);
            if (url.pathname.endsWith("/cancel"))
                return Response.json({ status: "cancelled" });
            return Response.json({
                id,
                upload: {
                    url: "https://storage.example.com/original",
                    method: "PUT",
                    headers: {},
                },
            });
        },
        async () => new Response(null, { status: 500 }),
    );
    expect(
        client.replaceImage(
            id,
            new File(["bytes"], "image.png", { type: "image/png" }),
        ),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(paths).toEqual([
        `/api/photos/${id}/uploads`,
        `/api/photos/${id}/uploads/${id}/cancel`,
    ]);
});
