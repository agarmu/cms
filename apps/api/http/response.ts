// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
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

export function assetUrl(
    photoId: string,
    filename: string,
    prefix = "/api/photos",
) {
    return `${prefix}/${encodeURIComponent(photoId)}/assets/${encodeURIComponent(filename)}`;
}

export function photoResponse(
    photo: Awaited<ReturnType<typeof PhotoApi.read>>,
): z.infer<typeof photoSchema> {
    return {
        id: photo.id,
        takenAt: photo.takenAt,
        postedAt: photo.postedAt,
        altText: photo.altText,
        caption: photo.caption,
        description: photo.description,
        location: photo.location,
        visible: photo.visible,
        camera: photo.camera,
        lens: photo.lens,
        assets: photo.assets.map((asset) => ({
            id: asset.id,
            filename: asset.assetLocation,
            width: asset.width,
            height: asset.height,
            byteSize: asset.byteSize,
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
    takenAt: z.date(),
    postedAt: z.date(),
    altText: z.string(),
    caption: z.string(),
    description: z.string(),
    location: z.string().nullable(),
    visible: z.boolean(),
    camera: equipmentResponse.nullable(),
    lens: equipmentResponse.nullable(),
    assets: z.array(
        z.object({
            id: ApiValidation.assetId,
            filename: z.string(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            byteSize: z.int().positive().nullable(),
            url: z.string(),
        }),
    ),
});
