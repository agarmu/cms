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
import { Elysia, status } from "elysia";
import { z } from "zod";
import { ImageUploadApi } from "../api/image-uploads";
import { ApiValidation } from "../api/validation";
import { Scope } from "../api/scope";
import type { ImageStorage } from "../services/image-storage";
import type { HttpAccess } from "./scope";
import { downloadResponse, downloadSchema } from "./response";

export class UploadValidation {
    static readonly uploadRequest = z.strictObject({
        contentType: z.enum([
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/avif",
            "image/tiff",
        ]),
    });
}

const uploadStatus = z.object({
    id: ApiValidation.uuid,
    status: z.enum([
        "pending",
        "ready",
        "completed",
        "cancelled",
        "failed",
        "expired",
    ]),
    processedAt: z.date().nullable(),
    completedAt: z.date().nullable(),
    cancelledAt: z.date().nullable(),
    expiresAt: z.date(),
    error: z.string().nullable(),
});
const createdUpload = uploadStatus.extend({
    upload: z.object({
        url: z.url(),
        method: z.literal("PUT"),
        headers: z.record(z.string(), z.string()),
        expiresIn: z.number().int().positive(),
    }),
});
const uploadResponse = uploadStatus.extend({
    assets: z.array(
        z.object({
            filename: z.string(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            byteSize: z.int().positive().nullable(),
            url: z.string(),
        }),
    ),
});

export class PhotoUploadRoutes {
    readonly app;

    constructor(access: HttpAccess, getStorage: () => ImageStorage) {
        const params = z.object({ uploadId: ApiValidation.uuid });
        this.app = new Elysia({ prefix: "/api/photo-uploads" })
            .use(access.plugin)
            .post(
                "",
                async ({ db, body, authIdentity, set }) => {
                    const upload = await ImageUploadApi.create(
                        db,
                        getStorage(),
                        body.contentType,
                        authIdentity,
                    );
                    set.headers["Location"] = `/api/photo-uploads/${upload.id}`;
                    return status(201, upload);
                },
                {
                    detail: { summary: "Start a new-photo upload" },
                    write: Scope.PhotosCreate,
                    body: UploadValidation.uploadRequest,
                    response: { 201: createdUpload },
                },
            )
            .get(
                "/:uploadId",
                ({ db, params, authIdentity }) =>
                    ImageUploadApi.read(db, params.uploadId, authIdentity),
                {
                    detail: { summary: "Read new-photo upload status" },
                    write: Scope.PhotosCreate,
                    params,
                    response: uploadResponse,
                },
            )
            .get(
                "/:uploadId/assets/:filename",
                async ({ db, params, authIdentity }) =>
                    downloadResponse(
                        await ImageUploadApi.readAsset(
                            db,
                            getStorage(),
                            params.uploadId,
                            params.filename,
                            authIdentity,
                        ),
                    ),
                {
                    detail: { summary: "Preview a processed upload asset" },
                    write: Scope.PhotosCreate,
                    params: params.extend({ filename: z.string() }),
                    response: downloadSchema,
                },
            )
            .post(
                "/:uploadId/complete",
                ({ db, params, authIdentity }) =>
                    ImageUploadApi.finish(
                        db,
                        getStorage(),
                        params.uploadId,
                        authIdentity,
                    ),
                {
                    detail: { summary: "Process a new-photo upload" },
                    write: Scope.PhotosCreate,
                    params,
                    response: uploadResponse,
                },
            )
            .post(
                "/:uploadId/cancel",
                ({ db, params, authIdentity }) =>
                    ImageUploadApi.cancel(db, params.uploadId, authIdentity),
                {
                    detail: { summary: "Cancel a new-photo upload" },
                    write: Scope.PhotosCreate,
                    params,
                    response: uploadResponse,
                },
            );
    }
}

export class ImageUploadRoutes {
    readonly app;

    constructor(access: HttpAccess, getStorage: () => ImageStorage) {
        const photo = z.object({ id: ApiValidation.uuid });
        const params = photo.extend({ uploadId: ApiValidation.uuid });
        this.app = new Elysia({ prefix: "/api/photos" })
            .use(access.plugin)
            .post(
                "/:id/uploads",
                async ({ db, params, body, authIdentity, set }) => {
                    const upload = await ImageUploadApi.replace(
                        db,
                        getStorage(),
                        params.id,
                        body.contentType,
                        authIdentity,
                    );
                    set.headers["Location"] =
                        `/api/photos/${params.id.toLowerCase()}/uploads/${upload.id}`;
                    return status(201, upload);
                },
                {
                    detail: { summary: "Start a photo image replacement" },
                    write: Scope.PhotosAssetsWrite,
                    params: photo,
                    body: UploadValidation.uploadRequest,
                    response: { 201: createdUpload },
                },
            )
            .get(
                "/:id/uploads/:uploadId",
                ({ db, params, authIdentity }) =>
                    ImageUploadApi.read(
                        db,
                        params.uploadId,
                        authIdentity,
                        params.id,
                    ),
                {
                    detail: { summary: "Read image replacement status" },
                    write: Scope.PhotosAssetsWrite,
                    params,
                    response: uploadResponse,
                },
            )
            .post(
                "/:id/uploads/:uploadId/complete",
                ({ db, params, authIdentity }) =>
                    ImageUploadApi.finish(
                        db,
                        getStorage(),
                        params.uploadId,
                        authIdentity,
                        params.id,
                    ),
                {
                    detail: {
                        summary: "Process and attach replacement assets",
                    },
                    write: Scope.PhotosAssetsWrite,
                    params,
                    response: uploadResponse,
                },
            )
            .post(
                "/:id/uploads/:uploadId/cancel",
                ({ db, params, authIdentity }) =>
                    ImageUploadApi.cancel(
                        db,
                        params.uploadId,
                        authIdentity,
                        params.id,
                    ),
                {
                    detail: { summary: "Cancel a photo image replacement" },
                    write: Scope.PhotosAssetsWrite,
                    params,
                    response: uploadResponse,
                },
            );
    }
}
