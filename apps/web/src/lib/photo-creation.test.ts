import { expect, test } from "bun:test";
import { CmsClient, type NewPhoto } from "./cms-client";

const uploadId = "10383333-4444-4333-8333-111111111111";
const photoId = "10383333-4444-4333-8333-222222222222";
const metadata: NewPhoto = {
    takenAt: "2026-10-17T12:00:00.000Z",
    postedAt: "2026-10-17T13:00:00.000Z",
    caption: "Caption",
    description: "A **Markdown** description",
    altText: "An image alternative",
    location: null,
    visible: true,
    camera: null,
    lens: null,
};
const image = () =>
    new File(["image bytes"], "photo.png", { type: "image/png" });
const receipt = (url = "https://storage.example.com/original") => ({
    id: uploadId,
    upload: { url, method: "PUT", headers: { "Content-Type": "image/png" } },
});

test("new photos upload, process, then create with credentials restricted to the CMS", async () => {
    const paths: string[] = [];
    const progress: string[] = [];
    const controller = new AbortController();
    const client = new CmsClient(
        "https://cms.example.com/",
        async () => "cms-token",
        async (url, init) => {
            paths.push(url.pathname);
            expect(new Headers(init.headers).get("Authorization")).toBe(
                "Bearer cms-token",
            );
            expect(init.signal).toBe(controller.signal);
            if (url.pathname === "/api/photo-uploads")
                return Response.json(receipt());
            if (url.pathname.endsWith("/complete"))
                return Response.json({ status: "ready" });
            expect(url.pathname).toBe("/api/photos");
            expect(JSON.parse(init.body as string)).toEqual({
                uploadId,
                ...metadata,
            });
            return Response.json({ id: photoId });
        },
        async (url, init) => {
            expect(url.href).toBe("https://storage.example.com/original");
            expect(init.method).toBe("PUT");
            expect(init.credentials).toBe("omit");
            expect(init.redirect).toBe("error");
            expect(new Headers(init.headers).has("Authorization")).toBe(false);
            expect(init.signal).toBe(controller.signal);
            return new Response(null, { status: 200 });
        },
    );
    const id = await client.preparePhotoUpload(
        image(),
        controller.signal,
        (phase) => progress.push(phase),
    );
    expect(id).toBe(uploadId);
    expect(paths).toEqual([
        "/api/photo-uploads",
        `/api/photo-uploads/${uploadId}/complete`,
    ]);
    expect(progress).toEqual(["uploading", "processing"]);
    expect(await client.createPhoto(id, metadata, controller.signal)).toEqual({
        id: photoId,
    });
});

test("creation retries reuse the same receipt and metadata without uploading again", async () => {
    const bodies: unknown[] = [];
    const client = new CmsClient(
        "https://cms.example.com/",
        async () => undefined,
        async (url, init) => {
            expect(url.pathname).toBe("/api/photos");
            bodies.push(JSON.parse(init.body as string));
            return bodies.length === 1
                ? new Response(null, { status: 500 })
                : Response.json({ id: photoId });
        },
    );
    await expect(client.createPhoto(uploadId, metadata)).rejects.toThrow();
    expect(await client.createPhoto(uploadId, metadata)).toEqual({
        id: photoId,
    });
    expect(bodies[0]).toEqual(bodies[1]);
});

test.each([
    "https://user:secret@storage.example.com/original",
    "http://storage.example.com/original",
])("unsafe upload URL %s is refused and its receipt cancelled", async (url) => {
    const paths: string[] = [];
    let puts = 0;
    const client = new CmsClient(
        "https://cms.example.com/",
        async () => undefined,
        async (request) => {
            paths.push(request.pathname);
            return Response.json(
                request.pathname.endsWith("/cancel")
                    ? { status: "cancelled" }
                    : receipt(url),
            );
        },
        async () => {
            puts++;
            return new Response();
        },
    );
    await expect(client.preparePhotoUpload(image())).rejects.toThrow(
        "unsafe upload URL",
    );
    expect(puts).toBe(0);
    expect(paths).toEqual([
        "/api/photo-uploads",
        `/api/photo-uploads/${uploadId}/cancel`,
    ]);
});

test("aborting a byte upload still cancels its receipt with a live cleanup signal", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const client = new CmsClient(
        "https://cms.example.com/",
        async () => undefined,
        async (url, init) => {
            if (url.pathname.endsWith("/cancel")) {
                cancelled = true;
                expect(init.signal?.aborted).toBe(false);
                return Response.json({ status: "cancelled" });
            }
            return Response.json(receipt());
        },
        async () => {
            controller.abort();
            throw new DOMException("Aborted", "AbortError");
        },
    );
    await expect(
        client.preparePhotoUpload(image(), controller.signal),
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
});

test("creation rejects invalid metadata and file types before requesting an upload", async () => {
    let requests = 0;
    const client = new CmsClient(
        "https://cms.example.com/",
        async () => undefined,
        async () => {
            requests++;
            return new Response();
        },
    );
    await expect(client.createPhoto("invalid", metadata)).rejects.toThrow();
    await expect(
        client.createPhoto(uploadId, { ...metadata, assets: [] } as never),
    ).rejects.toThrow();
    await expect(
        client.preparePhotoUpload(
            new File(["text"], "photo.txt", { type: "text/plain" }),
        ),
    ).rejects.toThrow();
    await expect(
        client.preparePhotoUpload(
            new File([], "empty.png", { type: "image/png" }),
        ),
    ).rejects.toThrow();
    expect(requests).toBe(0);
});
