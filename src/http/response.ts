import type { PhotoApi } from "../api/photos";

export function assetUrl(photoId: string, filename: string) {
    return `/photos/${encodeURIComponent(photoId)}/assets/${encodeURIComponent(filename)}`;
}

export function photoResponse(
    photo: Awaited<ReturnType<typeof PhotoApi.read>>,
) {
    return {
        id: photo.id,
        taken: photo.taken,
        posted: photo.posted,
        alt: photo.alt,
        description: photo.description,
        enabled: photo.enabled,
        camera: photo.camera,
        lens: photo.lens,
        assets: photo.assets.map((asset) => ({
            id: asset.id,
            filename: asset.assetLocation,
            width: asset.width,
            height: asset.height,
            url: assetUrl(photo.id, asset.assetLocation),
        })),
    };
}
