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
            byteSize: z.int().positive().nullable().default(null),
            url: z.string(),
        }),
    ),
});
const photoPageSchema = z.object({
    items: z.array(photoSchema),
    limit: z.int().min(1).max(100),
    offset: z.int().nonnegative(),
});
export const newPhotoSchema = photoSchema
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
    .strict();
export const photoChangesSchema = newPhotoSchema
    .partial()
    .refine((changes) =>
        Object.values(changes).some((value) => value !== undefined),
    );
const signedImageSchema = z.object({
    url: z.url(),
    expiresAt: z.iso.datetime({ offset: true }),
});

export type Photo = z.infer<typeof photoSchema>;
export type PhotoChanges = z.infer<typeof photoChangesSchema>;
export type NewPhoto = z.infer<typeof newPhotoSchema>;
export type UploadPhase = "uploading" | "processing";
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

export type LibraryClient = Pick<
    CmsClient,
    | "clearCache"
    | "listPhotos"
    | "readPhoto"
    | "updatePhoto"
    | "listEquipment"
    | "renameEquipment"
    | "replaceImage"
    | "preparePhotoUpload"
    | "createPhoto"
    | "cancelPhotoUpload"
    | "readImage"
>;

export class CmsClient {
    private readonly base: URL;
    private readonly reads = new Map<
        string,
        { value: unknown; expiresAt: number; bytes: number; image: boolean }
    >();
    private cachedToken: string | undefined;
    private revision = 0;
    private cachedBytes = 0;
    private readonly maxCachedBytes = 24 * 1024 * 1024;

    constructor(
        baseUrl: string,
        private readonly getAccessToken: () => Promise<string | undefined>,
        private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
        private readonly uploadFetcher: Fetcher = (url, init) =>
            fetch(url, init),
        private readonly apiPrefix: "/api" | "/api/demo" = "/api",
    ) {
        this.base = new URL(baseUrl);
    }

    clearCache() {
        this.reads.clear();
        this.cachedBytes = 0;
        this.cachedToken = undefined;
        this.revision++;
    }

    private forget(path: string) {
        this.cachedBytes -= this.reads.get(path)?.bytes ?? 0;
        this.reads.delete(path);
    }

    private async cached<T>(path: string, signal?: AbortSignal) {
        signal?.throwIfAborted();
        // Check the current credentials even when no network request is needed.
        const token = await this.getAccessToken();
        signal?.throwIfAborted();
        if (token !== this.cachedToken) {
            this.clearCache();
            this.cachedToken = token;
        }
        const entry = this.reads.get(path);
        if (entry && entry.expiresAt > Date.now()) {
            this.reads.delete(path);
            this.reads.set(path, entry);
            return { value: entry.value as T, revision: this.revision };
        }
        this.forget(path);
        return { value: undefined, revision: this.revision };
    }

    private remember(
        path: string,
        value: unknown,
        revision: number,
        signal?: AbortSignal,
        ttl = 30_000,
        image = false,
        bytes = 0,
    ) {
        if (
            revision !== this.revision ||
            signal?.aborted ||
            ttl <= 0 ||
            bytes > this.maxCachedBytes
        )
            return;
        this.forget(path);
        while (
            this.reads.size >= 100 ||
            this.cachedBytes + bytes > this.maxCachedBytes
        )
            this.forget(this.reads.keys().next().value!);
        this.reads.set(path, {
            value,
            expiresAt: Date.now() + ttl,
            image,
            bytes,
        });
        this.cachedBytes += bytes;
    }

    async request(path: string, init: RequestInit = {}) {
        const url = new URL(path, this.base);
        if (
            url.origin !== this.base.origin ||
            !url.pathname.startsWith(`${this.apiPrefix}/`) ||
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
        const method = (init.method ?? "GET").toUpperCase();
        if (method === "DELETE") this.clearCache();
        else if (!["GET", "HEAD"].includes(method)) {
            this.revision++;
            for (const [path, entry] of this.reads)
                if (!entry.image) this.forget(path);
        }
        return response;
    }

    async listPhotos(offset: number, limit: number, signal?: AbortSignal) {
        const path = `${this.apiPrefix}/photos?limit=${limit}&offset=${offset}`;
        const cached = await this.cached<z.infer<typeof photoPageSchema>>(
            path,
            signal,
        );
        if (cached.value) return cached.value;
        const response = await this.request(path, signal ? { signal } : {});
        const page = photoPageSchema.parse(await response.json());
        this.remember(path, page, cached.revision, signal);
        for (const photo of page.items)
            this.remember(
                `${this.apiPrefix}/photos/${photo.id}`,
                photo,
                cached.revision,
                signal,
            );
        return page;
    }

    async readPhoto(id: string, signal?: AbortSignal) {
        const path = `${this.apiPrefix}/photos/${encodeURIComponent(z.uuid().parse(id))}`;
        const cached = await this.cached<Photo>(path, signal);
        if (cached.value) return cached.value;
        const response = await this.request(path, signal ? { signal } : {});
        const photo = photoSchema.parse(await response.json());
        this.remember(path, photo, cached.revision, signal);
        return photo;
    }

    async updatePhoto(id: string, changes: PhotoChanges, signal?: AbortSignal) {
        const response = await this.request(
            `${this.apiPrefix}/photos/${encodeURIComponent(z.uuid().parse(id))}`,
            {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(photoChangesSchema.parse(changes)),
                ...(signal ? { signal } : {}),
            },
        );
        return z
            .union([photoSchema, z.strictObject({ id: z.uuid() })])
            .parse(await response.json());
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
                `${this.apiPrefix}/${kind === "camera" ? "cameras" : "lenses"}?offset=${offset}&limit=100`,
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
            `${this.apiPrefix}/${kind === "camera" ? "cameras" : "lenses"}/${z.uuid().parse(id)}`,
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
        const path = `${this.apiPrefix}/photos/${z.uuid().parse(id)}/uploads`;
        await this.uploadImage(path, file, "completed", signal);
        return this.readPhoto(id, signal);
    }

    async preparePhotoUpload(
        file: File,
        signal?: AbortSignal,
        progress?: (phase: UploadPhase) => void,
    ) {
        return this.uploadImage(
            `${this.apiPrefix}/photo-uploads`,
            file,
            "ready",
            signal,
            progress,
        );
    }

    async createPhoto(
        uploadId: string,
        metadata: NewPhoto,
        signal?: AbortSignal,
    ) {
        const body = {
            uploadId: z.uuid().parse(uploadId),
            ...newPhotoSchema.parse(metadata),
        };
        const response = await this.request(`${this.apiPrefix}/photos`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            ...(signal ? { signal } : {}),
        });
        return z.object({ id: z.uuid() }).parse(await response.json());
    }

    async cancelPhotoUpload(uploadId: string) {
        await this.request(
            `${this.apiPrefix}/photo-uploads/${z.uuid().parse(uploadId)}/cancel`,
            {
                method: "POST",
                signal: AbortSignal.timeout(5000),
            },
        );
    }

    private async uploadImage(
        path: string,
        file: File,
        expectedStatus: "ready" | "completed",
        signal?: AbortSignal,
        progress?: (phase: UploadPhase) => void,
    ) {
        const contentType = z
            .enum([
                "image/jpeg",
                "image/png",
                "image/webp",
                "image/avif",
                "image/tiff",
            ])
            .parse(file.type);
        if (!file.size) throw new Error("Choose a non-empty image.");
        progress?.("uploading");
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
        try {
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
            const upload = await this.uploadFetcher(uploadUrl, {
                method: "PUT",
                headers: receipt.upload.headers,
                body: file,
                credentials: "omit",
                redirect: "error",
                ...(signal ? { signal } : {}),
            });
            if (!upload.ok) throw new Error("The image upload failed.");
            progress?.("processing");
            const completed = await this.request(
                `${path}/${receipt.id}/complete`,
                { method: "POST", ...(signal ? { signal } : {}) },
            );
            z.object({ status: z.literal(expectedStatus) }).parse(
                await completed.json(),
            );
            return receipt.id;
        } catch (error) {
            await this.request(`${path}/${receipt.id}/cancel`, {
                method: "POST",
                signal: AbortSignal.timeout(5000),
            }).catch(() => {});
            throw error;
        }
    }

    async readImage(path: string, signal?: AbortSignal): Promise<ImageSource> {
        const cached = await this.cached<ImageSource>(path, signal);
        if (cached.value) return cached.value;
        const response = await this.request(path, signal ? { signal } : {});
        const contentType = response.headers.get("Content-Type") ?? "";
        if (contentType.startsWith("image/")) {
            const source = {
                kind: "blob",
                blob: await response.blob(),
            } as const;
            this.remember(
                path,
                source,
                cached.revision,
                signal,
                120_000,
                true,
                source.blob.size,
            );
            return source;
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
            const source = { kind: "remote", url: url.href } as const;
            this.remember(
                path,
                source,
                cached.revision,
                signal,
                Math.min(
                    120_000,
                    Date.parse(signed.expiresAt) - Date.now() - 5000,
                ),
                true,
            );
            return source;
        }
        throw new Error("The CMS returned an unsupported image response.");
    }
}

export function selectAsset(
    assets: PhotoAsset[],
    targetWidth: number,
    targetHeight = Infinity,
) {
    const reference = assets[0];
    if (reference)
        targetWidth = Math.min(
            targetWidth,
            (targetHeight * reference.width) / reference.height,
        );
    const sorted = assets.toSorted((a, b) => a.width - b.width);
    return sorted.find((asset) => asset.width >= targetWidth) ?? sorted.at(-1);
}
