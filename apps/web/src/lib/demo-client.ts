import { z } from "zod";
import {
    ApiError,
    newPhotoSchema,
    photoChangesSchema,
    type LibraryClient,
    type NewPhoto,
    type Photo,
    type PhotoChanges,
    type PhotoAsset,
    type ImageSource,
    type UploadPhase,
} from "./cms-client";

type Equipment = NonNullable<Photo["camera"]>;
type Dimensions = { width: number; height: number };
export type DemoReader = Pick<
    LibraryClient,
    "listPhotos" | "listEquipment" | "readImage" | "clearCache"
>;

async function imageDimensions(file: File): Promise<Dimensions> {
    const url = URL.createObjectURL(file);
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
    } catch {
        throw new Error("Choose an image your browser can display.");
    } finally {
        URL.revokeObjectURL(url);
    }
}

export class DemoClient implements LibraryClient {
    private readonly data = {
        photos: [] as Photo[],
        images: new Map<string, Blob>(),
    };
    private readonly equipment = {
        camera: [] as Equipment[],
        lens: [] as Equipment[],
    };
    private readonly uploads = new Map<
        string,
        { asset: PhotoAsset; photoId?: string; input?: string }
    >();
    private nextAsset = 1;
    private initialization: Promise<void> | undefined;

    constructor(
        private readonly reader: DemoReader,
        private readonly dimensions = imageDimensions,
    ) {}

    // Keep the tab's edits while allowing image credentials to be refreshed.
    clearCache() {
        this.reader.clearCache();
    }

    private async initialize(signal?: AbortSignal) {
        signal?.throwIfAborted();
        this.initialization ??= this.loadSnapshot().catch((error: unknown) => {
            this.initialization = undefined;
            throw error;
        });
        await this.initialization;
        signal?.throwIfAborted();
    }

    private async loadSnapshot() {
        const readPhotos = async () => {
            const photos: Photo[] = [];
            for (let offset = 0; ; offset += 100) {
                const page = await this.reader.listPhotos(offset, 100);
                photos.push(...page.items);
                if (page.items.length < 100) return photos;
            }
        };
        // Only metadata is fetched here. Image bytes load when an image is viewed.
        // Share startup across callers so an aborted navigation cannot poison it.
        const [photos, cameras, lenses] = await Promise.all([
            readPhotos(),
            this.reader.listEquipment("camera"),
            this.reader.listEquipment("lens"),
        ]);
        this.data.photos.push(...structuredClone(photos));
        this.equipment.camera.push(...structuredClone(cameras));
        this.equipment.lens.push(...structuredClone(lenses));
        this.nextAsset =
            1 +
            photos.reduce(
                (max, photo) =>
                    photo.assets.reduce(
                        (max, asset) => Math.max(max, asset.id),
                        max,
                    ),
                0,
            );
    }

    async listPhotos(offset: number, limit: number, signal?: AbortSignal) {
        signal?.throwIfAborted();
        z.int().nonnegative().parse(offset);
        z.int().min(1).max(100).parse(limit);
        await this.initialize(signal);
        const sorted = this.data.photos.toSorted(
            (a, b) =>
                Date.parse(b.postedAt) - Date.parse(a.postedAt) ||
                b.id.localeCompare(a.id),
        );
        return {
            items: structuredClone(sorted.slice(offset, offset + limit)),
            offset,
            limit,
        };
    }

    private photo(id: string) {
        z.uuid().parse(id);
        const photo = this.data.photos.find((photo) => photo.id === id);
        if (!photo)
            throw new ApiError(404, "This demo photo could not be found.");
        return photo;
    }

    async readPhoto(id: string, signal?: AbortSignal) {
        await this.initialize(signal);
        return structuredClone(this.photo(id));
    }

    private resolveEquipment(
        kind: "camera" | "lens",
        link: NewPhoto["camera"],
    ): Equipment | null {
        if (!link) return null;
        if ("create" in link) {
            const item = { id: crypto.randomUUID(), name: link.create.name };
            this.equipment[kind].push(item);
            return { ...item };
        }
        const item = this.equipment[kind].find((item) => item.id === link.id);
        if (!item)
            throw new ApiError(404, "This demo equipment could not be found.");
        return { ...item };
    }

    private apply(photo: Photo, changes: PhotoChanges) {
        // Resolve existing links before creating equipment or mutating the photo.
        for (const kind of ["camera", "lens"] as const) {
            const link = changes[kind];
            if (link && "id" in link) this.resolveEquipment(kind, link);
        }
        const { camera, lens, ...text } = changes;
        Object.assign(photo, text);
        if (camera !== undefined)
            photo.camera = this.resolveEquipment("camera", camera);
        if (lens !== undefined)
            photo.lens = this.resolveEquipment("lens", lens);
    }

    async updatePhoto(id: string, changes: PhotoChanges, signal?: AbortSignal) {
        await this.initialize(signal);
        const photo = this.photo(id);
        this.apply(photo, photoChangesSchema.parse(changes));
        return structuredClone(photo);
    }

    async listEquipment(kind: "camera" | "lens", signal?: AbortSignal) {
        await this.initialize(signal);
        return structuredClone(
            this.equipment[kind].toSorted((a, b) =>
                a.name.localeCompare(b.name),
            ),
        );
    }

    async renameEquipment(
        kind: "camera" | "lens",
        id: string,
        name: string,
        signal?: AbortSignal,
    ) {
        await this.initialize(signal);
        z.uuid().parse(id);
        const item = this.equipment[kind].find((item) => item.id === id);
        if (!item)
            throw new ApiError(404, "This demo equipment could not be found.");
        item.name = z.string().trim().min(1).parse(name);
        for (const photo of this.data.photos) {
            if (photo[kind]?.id === id) photo[kind] = { ...item };
        }
        return { ...item };
    }

    private async asset(file: File, signal?: AbortSignal): Promise<PhotoAsset> {
        signal?.throwIfAborted();
        if (!file.size) throw new Error("Choose a non-empty image.");
        if (file.size > 25 * 1024 * 1024)
            throw new Error("Demo images must be 25 MiB or smaller.");
        z.enum([
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/avif",
            "image/tiff",
        ]).parse(file.type);
        const { width, height } = await this.dimensions(file);
        signal?.throwIfAborted();
        z.int().positive().parse(width);
        z.int().positive().parse(height);
        const id = this.nextAsset++;
        const url = `/api/demo/images/uploads/${id}`;
        this.data.images.set(url, file);
        return {
            id,
            url,
            filename: file.name,
            width,
            height,
            byteSize: file.size,
        };
    }

    async replaceImage(id: string, file: File, signal?: AbortSignal) {
        await this.initialize(signal);
        const photo = this.photo(id);
        const asset = await this.asset(file, signal);
        for (const previous of photo.assets)
            this.data.images.delete(previous.url);
        photo.assets = [asset];
        return structuredClone(photo);
    }

    async preparePhotoUpload(
        file: File,
        signal?: AbortSignal,
        progress?: (phase: UploadPhase) => void,
    ) {
        await this.initialize(signal);
        progress?.("uploading");
        const asset = await this.asset(file, signal);
        const id = crypto.randomUUID();
        this.uploads.set(id, { asset });
        progress?.("processing");
        return id;
    }

    async createPhoto(
        uploadId: string,
        metadata: NewPhoto,
        signal?: AbortSignal,
    ) {
        await this.initialize(signal);
        z.uuid().parse(uploadId);
        const values = newPhotoSchema.parse(metadata);
        const upload = this.uploads.get(uploadId);
        if (!upload)
            throw new ApiError(
                404,
                "Choose an image before adding a demo photo.",
            );
        const input = JSON.stringify(values);
        if (upload.photoId) {
            if (upload.input !== input)
                throw new ApiError(
                    409,
                    "This upload was already used for a different demo photo.",
                );
            return { id: upload.photoId };
        }
        const id = crypto.randomUUID();
        const photo: Photo = {
            ...values,
            id,
            camera: null,
            lens: null,
            assets: [upload.asset],
        };
        this.apply(photo, values);
        this.data.photos.push(photo);
        upload.photoId = id;
        upload.input = input;
        return { id };
    }

    async cancelPhotoUpload(uploadId: string) {
        const upload = this.uploads.get(z.uuid().parse(uploadId));
        if (!upload || upload.photoId) return;
        this.data.images.delete(upload.asset.url);
        this.uploads.delete(uploadId);
    }

    async readImage(path: string, signal?: AbortSignal): Promise<ImageSource> {
        await this.initialize(signal);
        const blob = this.data.images.get(path);
        if (blob) return { kind: "blob", blob };
        if (
            this.data.photos.some((photo) =>
                photo.assets.some((asset) => asset.url === path),
            )
        )
            return this.reader.readImage(path, signal);
        throw new ApiError(404, "This demo image could not be found.");
    }
}
