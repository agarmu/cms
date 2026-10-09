import { z } from "zod";
import { ApiValidation } from "../api/validation";
import { equipmentResponse } from "./equipment";
import type { PhotoApi } from "../api/photos";
import type { BlobDownload } from "../services/blob-storage";
import { Tracing } from "../telemetry/tracing";

export function downloadResponse(stored: BlobDownload) {
    if ("url" in stored)
        return { url: stored.url, expiresAt: stored.expiresAt };
    return new Response(
        Tracing.tracedStream("image.asset.download", () =>
            stored.file.stream(),
        ),
        {
            headers: { "Content-Type": stored.file.type },
        },
    );
}

export function assetUrl(photoId: string, filename: string) {
    return `/api/photos/${encodeURIComponent(photoId)}/assets/${encodeURIComponent(filename)}`;
}

export function photoResponse(
    photo: Awaited<ReturnType<typeof PhotoApi.read>>,
): z.infer<typeof photoSchema> {
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

export const downloadSchema = z.union([
    z.object({ url: z.url(), expiresAt: z.date() }),
    z.instanceof(Response).meta({
        type: "string",
        format: "binary",
        description:
            "Local storage returns image bytes with the image content type.",
    }),
]);
export const photoSchema = z.object({
    id: ApiValidation.uuid,
    taken: z.date(),
    posted: z.date(),
    alt: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    camera: equipmentResponse.nullable(),
    lens: equipmentResponse.nullable(),
    assets: z.array(
        z.object({
            id: ApiValidation.assetId,
            filename: z.string(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            url: z.string(),
        }),
    ),
});
