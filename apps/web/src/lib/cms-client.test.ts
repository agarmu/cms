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
    url: `/api/photos/${id}/assets/small.webp`,
};
const photo = {
    id,
    taken: date,
    posted: date,
    alt: "A photo",
    description: "",
    enabled: true,
    camera: null,
    lens: null,
    assets: [asset],
};

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
