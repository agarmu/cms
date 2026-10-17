import { z } from "zod";

const equipment = z.object({ id: z.uuid(), name: z.string() });
export const photoSchema = z.object({
    id: z.uuid(),
    taken: z.iso.datetime({ offset: true }),
    posted: z.iso.datetime({ offset: true }),
    alt: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    camera: equipment.nullable(),
    lens: equipment.nullable(),
    assets: z.array(
        z.object({
            id: z.int().positive(),
            filename: z.string(),
            width: z.int().positive(),
            height: z.int().positive(),
            url: z.string(),
        }),
    ),
});
const photoPageSchema = z.object({
    items: z.array(photoSchema),
    limit: z.int().min(1).max(100),
    offset: z.int().nonnegative(),
});
const signedImageSchema = z.object({
    url: z.url(),
    expiresAt: z.iso.datetime({ offset: true }),
});

export type Photo = z.infer<typeof photoSchema>;
export type PhotoAsset = Photo["assets"][number];
export type ImageSource =
    { kind: "blob"; blob: Blob } | { kind: "remote"; url: string };

export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = "ApiError";
    }
}

type Fetcher = (url: URL, init: RequestInit) => Promise<Response>;

export class CmsClient {
    private readonly base: URL;

    constructor(
        baseUrl: string,
        private readonly getAccessToken: () => Promise<string | undefined>,
        private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
    ) {
        this.base = new URL(baseUrl);
    }

    async request(path: string, init: RequestInit = {}) {
        const url = new URL(path, this.base);
        if (
            url.origin !== this.base.origin ||
            !url.pathname.startsWith("/api/") ||
            url.username ||
            url.password
        ) {
            throw new Error("Requests must target the configured CMS API.");
        }

        const headers = new Headers(init.headers);
        // Only the session may supply credentials, and only to the CMS origin.
        headers.delete("Authorization");
        const token = await this.getAccessToken();
        if (token) headers.set("Authorization", `Bearer ${token}`);
        const response = await this.fetcher(url, {
            ...init,
            headers,
            credentials: "omit",
            redirect: "error",
        });
        if (!response.ok) {
            const messages: Record<number, string> = {
                401: "Your session has ended. Sign in again to continue.",
                403: "Your account does not have permission to view this content.",
                404: "This photo could not be found. It may have been removed or hidden.",
                503: "The CMS is temporarily unavailable. Please try again.",
            };
            throw new ApiError(
                response.status,
                messages[response.status] ??
                    `The CMS request failed (HTTP ${response.status}). Please try again.`,
            );
        }
        return response;
    }

    async listPhotos(offset: number, limit: number, signal?: AbortSignal) {
        const response = await this.request(
            `/api/photos?limit=${limit}&offset=${offset}`,
            signal ? { signal } : {},
        );
        return photoPageSchema.parse(await response.json());
    }

    async readPhoto(id: string, signal?: AbortSignal) {
        const response = await this.request(
            `/api/photos/${encodeURIComponent(z.uuid().parse(id))}`,
            signal ? { signal } : {},
        );
        return photoSchema.parse(await response.json());
    }

    async readImage(path: string, signal?: AbortSignal): Promise<ImageSource> {
        const response = await this.request(path, signal ? { signal } : {});
        const contentType = response.headers.get("Content-Type") ?? "";
        if (contentType.startsWith("image/")) {
            return { kind: "blob", blob: await response.blob() };
        }
        if (contentType.split(";")[0]?.trim() === "application/json") {
            const signed = signedImageSchema.parse(await response.json());
            const url = new URL(signed.url);
            if (
                (url.protocol !== "https:" &&
                    !(
                        url.protocol === "http:" &&
                        ["localhost", "127.0.0.1", "[::1]"].includes(
                            url.hostname,
                        )
                    )) ||
                url.username ||
                url.password
            ) {
                throw new Error("The CMS returned an unsafe image URL.");
            }
            // The browser loads this URL directly, without the CMS bearer token.
            return { kind: "remote", url: url.href };
        }
        throw new Error("The CMS returned an unsupported image response.");
    }
}

export function selectAsset(assets: PhotoAsset[], targetWidth: number) {
    const sorted = assets.toSorted((a, b) => a.width - b.width);
    return sorted.find((asset) => asset.width >= targetWidth) ?? sorted.at(-1);
}
