import { z } from "zod";

const equipment = z.object({ id: z.uuid(), name: z.string() });
export const photoSchema = z.object({
    id: z.uuid(),
    takenAt: z.iso.datetime({ offset: true }),
    postedAt: z.iso.datetime({ offset: true }),
    altText: z.string(),
    caption: z.string(),
    description: z.string(),
    location: z.string().nullable(),
    visible: z.boolean(),
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
const photoChangesSchema = photoSchema
    .pick({
        altText: true,
        caption: true,
        description: true,
        location: true,
        takenAt: true,
        postedAt: true,
        visible: true,
    })
    .extend({
        camera: z
            .union([
                z.strictObject({ id: z.uuid() }),
                z.strictObject({
                    create: z.strictObject({ name: z.string().trim().min(1) }),
                }),
            ])
            .nullable(),
        lens: z
            .union([
                z.strictObject({ id: z.uuid() }),
                z.strictObject({
                    create: z.strictObject({ name: z.string().trim().min(1) }),
                }),
            ])
            .nullable(),
    })
    .partial()
    .strict()
    .refine((changes) =>
        Object.values(changes).some((value) => value !== undefined),
    );
const signedImageSchema = z.object({
    url: z.url(),
    expiresAt: z.iso.datetime({ offset: true }),
});

export type Photo = z.infer<typeof photoSchema>;
export type PhotoChanges = z.infer<typeof photoChangesSchema>;
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
        private readonly uploadFetcher: Fetcher = (url, init) =>
            fetch(url, init),
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

    async updatePhoto(id: string, changes: PhotoChanges, signal?: AbortSignal) {
        const response = await this.request(
            `/api/photos/${encodeURIComponent(z.uuid().parse(id))}`,
            {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(photoChangesSchema.parse(changes)),
                ...(signal ? { signal } : {}),
            },
        );
        return photoSchema.parse(await response.json());
    }

    async listEquipment(kind: "camera" | "lens", signal?: AbortSignal) {
        const items: z.infer<typeof equipment>[] = [];
        const pageSchema = z.object({
            items: z.array(equipment),
            offset: z.int().nonnegative(),
            limit: z.int().positive(),
        });
        for (let offset = 0; ; offset += 100) {
            const response = await this.request(
                `/api/${kind === "camera" ? "cameras" : "lenses"}?offset=${offset}&limit=100`,
                signal ? { signal } : {},
            );
            const page = pageSchema.parse(await response.json());
            items.push(...page.items);
            if (page.items.length < 100) return items;
        }
    }

    async renameEquipment(
        kind: "camera" | "lens",
        id: string,
        name: string,
        signal?: AbortSignal,
    ) {
        const response = await this.request(
            `/api/${kind === "camera" ? "cameras" : "lenses"}/${z.uuid().parse(id)}`,
            {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: z.string().trim().min(1).parse(name),
                }),
                ...(signal ? { signal } : {}),
            },
        );
        return equipment.parse(await response.json());
    }

    async replaceImage(id: string, file: File, signal?: AbortSignal) {
        const path = `/api/photos/${z.uuid().parse(id)}/uploads`;
        const contentType = z
            .enum([
                "image/jpeg",
                "image/png",
                "image/webp",
                "image/avif",
                "image/tiff",
            ])
            .parse(file.type);
        const started = await this.request(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contentType }),
            ...(signal ? { signal } : {}),
        });
        const receipt = z
            .object({
                id: z.uuid(),
                upload: z.object({
                    url: z.url(),
                    method: z.literal("PUT"),
                    headers: z.record(z.string(), z.string()),
                }),
            })
            .parse(await started.json());
        const uploadUrl = new URL(receipt.upload.url);
        if (
            (uploadUrl.protocol !== "https:" &&
                !(
                    uploadUrl.protocol === "http:" &&
                    ["localhost", "127.0.0.1", "[::1]"].includes(
                        uploadUrl.hostname,
                    )
                )) ||
            uploadUrl.username ||
            uploadUrl.password
        )
            throw new Error("The CMS returned an unsafe upload URL.");
        try {
            const upload = await this.uploadFetcher(uploadUrl, {
                method: "PUT",
                headers: receipt.upload.headers,
                body: file,
                credentials: "omit",
                redirect: "error",
                ...(signal ? { signal } : {}),
            });
            if (!upload.ok) throw new Error("The image upload failed.");
            const completed = await this.request(
                `${path}/${receipt.id}/complete`,
                { method: "POST", ...(signal ? { signal } : {}) },
            );
            z.object({ status: z.literal("completed") }).parse(
                await completed.json(),
            );
            return await this.readPhoto(id, signal);
        } catch (error) {
            if (!signal?.aborted)
                await this.request(`${path}/${receipt.id}/cancel`, {
                    method: "POST",
                }).catch(() => {});
            throw error;
        }
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
