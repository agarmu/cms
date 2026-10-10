import { Elysia, status } from "elysia";
import { z } from "zod";
import { PhotoAccess } from "../api/photo-access";
import { Scope } from "../api/scope";
import { PhotoApi } from "../api/photos";
import { ImageUploadApi } from "../api/image-uploads";
import { ApiValidation } from "../api/validation";
import { NotFoundError } from "../lib/errors";
import type { HttpAccess } from "./scope";
import { HttpValidation as validation } from "./validation";
import type { ImageStorage } from "../services/image-storage";
import {
    downloadResponse,
    downloadSchema,
    photoResponse,
    photoSchema,
} from "./response";

export class PhotoRoutes {
    readonly app;

    constructor(access: HttpAccess, getStorage: () => ImageStorage) {
        const params = z.object({ id: validation.uuid });
        this.app = new Elysia({ prefix: "/api/photos" })
            .use(access.plugin)
            .get(
                "",
                async ({ db, query, authIdentity }) => ({
                    items: (await PhotoApi.list(db, query, authIdentity)).map(
                        photoResponse,
                    ),
                    ...query,
                }),
                {
                    read: Scope.PhotosRead,
                    query: validation.pagination,
                    response: z.object({
                        items: z.array(photoSchema),
                        ...ApiValidation.pagination.shape,
                    }),
                },
            )
            .get(
                "/:id",
                async ({ db, params, authIdentity }) =>
                    photoResponse(
                        await PhotoApi.read(db, params.id, authIdentity),
                    ),
                {
                    read: Scope.PhotosRead,
                    params,
                    response: photoSchema,
                },
            )
            .get(
                "/:id/image",
                async ({ db, params, authIdentity }) => {
                    const photo = await PhotoApi.read(
                        db,
                        params.id,
                        authIdentity,
                    );
                    const asset = photo.assets.toSorted(
                        (left, right) =>
                            right.width * right.height -
                            left.width * left.height,
                    )[0];
                    if (!asset)
                        throw new NotFoundError("Photo has no image assets");
                    const stored = await getStorage().read(
                        photo.id,
                        asset.assetLocation,
                    );
                    if (!stored)
                        throw new NotFoundError("Image asset not found");
                    return downloadResponse(stored);
                },
                { read: Scope.PhotosRead, params, response: downloadSchema },
            )
            .get(
                "/:id/assets/:filename",
                async ({ db, params, authIdentity }) => {
                    const photo = await PhotoApi.read(
                        db,
                        params.id,
                        authIdentity,
                    );
                    if (
                        !photo.assets.some(
                            (asset) => asset.assetLocation === params.filename,
                        )
                    )
                        throw new NotFoundError("Image asset not found");
                    const stored = await getStorage().read(
                        photo.id,
                        params.filename,
                    );
                    if (!stored)
                        throw new NotFoundError("Image asset not found");
                    return downloadResponse(stored);
                },
                {
                    read: Scope.PhotosRead,
                    params: params.extend({ filename: z.string() }),
                    response: downloadSchema,
                },
            )
            .post(
                "",
                async ({ db, body, authIdentity, set }) => {
                    const photo = await ImageUploadApi.createPhoto(
                        db,
                        body,
                        authIdentity,
                    );
                    set.headers["Location"] = `/api/photos/${photo.id}`;
                    return status(201, photo);
                },
                {
                    write: Scope.PhotosCreate,
                    body: validation.photo,
                    response: { 201: z.object({ id: validation.uuid }) },
                },
            )
            .patch(
                "/:id",
                async ({ db, params, body, authIdentity }) => {
                    PhotoAccess.requireChanges(authIdentity, body);
                    return photoResponse(
                        await PhotoApi.update(db, params.id, body),
                    );
                },
                {
                    write: [Scope.PhotosMetadataUpdate, Scope.PhotosTextUpdate],
                    params,
                    body: validation.photoChanges,
                    response: photoSchema,
                },
            )
            .delete(
                "/:id",
                async ({ db, params }) => {
                    await PhotoApi.remove(db, params.id);
                    return status(204, undefined);
                },
                {
                    write: Scope.PhotosDelete,
                    params,
                    response: { 204: z.undefined() },
                },
            );
    }
}
