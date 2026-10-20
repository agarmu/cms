import { CmsClient, type Photo } from "./cms-client";

export function demoFixture(count = 30) {
    const cameras = [
        { id: "10000000-0000-4000-8000-000000000001", name: "Trail camera" },
        { id: "10000000-0000-4000-8000-000000000002", name: "Pocket camera" },
    ];
    const lenses = [
        { id: "20000000-0000-4000-8000-000000000001", name: "35mm f/1.8" },
        { id: "20000000-0000-4000-8000-000000000002", name: "24–70mm f/2.8" },
    ];
    const photos: Photo[] = Array.from({ length: count }, (_, index) => {
        const id = `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
        return {
            id,
            caption: `Demo photo ${index + 1}`,
            description: "Photographer credit",
            altText: "A sample photo",
            takenAt: "2017-01-01T12:00:00Z",
            postedAt: new Date(Date.UTC(2026, 8, 30 - index)).toISOString(),
            location: null,
            visible: index % 7 !== 0,
            camera: null,
            lens: null,
            assets: [
                {
                    id: index + 1,
                    filename: "original.webp",
                    width: 1200,
                    height: 800,
                    byteSize: 11,
                    url: `/api/demo/photos/${id}/assets/original.webp`,
                },
            ],
        };
    });
    const requests: { path: string; method: string }[] = [];
    const fetcher = async (url: URL, init: RequestInit) => {
        const method = (init.method ?? "GET").toUpperCase();
        requests.push({ path: url.pathname, method });
        if (method !== "GET" || !url.pathname.startsWith("/api/demo/"))
            throw new Error("Only demo reads may reach the API");
        if (
            new Headers(init.headers).has("Authorization") ||
            init.credentials !== "omit"
        )
            throw new Error("Demo requests must omit credentials");
        if (url.pathname === "/api/demo/photos") {
            const offset = Number(url.searchParams.get("offset"));
            const limit = Number(url.searchParams.get("limit"));
            return Response.json({
                items: photos.slice(offset, offset + limit),
                offset,
                limit,
            });
        }
        if (
            url.pathname === "/api/demo/cameras" ||
            url.pathname === "/api/demo/lenses"
        )
            return Response.json({
                items: url.pathname.endsWith("cameras") ? cameras : lenses,
                offset: 0,
                limit: 100,
            });
        if (
            photos.some((photo) =>
                photo.assets.some((asset) => asset.url === url.pathname),
            )
        )
            return new Response("image bytes", {
                headers: { "Content-Type": "image/webp" },
            });
        return Response.json({ error: "Not found" }, { status: 404 });
    };
    const reader = new CmsClient(
        "https://cms.example.com/",
        async () => undefined,
        fetcher,
        undefined,
        "/api/demo",
    );
    return { reader, fetcher, requests, photos };
}
