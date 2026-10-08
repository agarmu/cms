import { Hono } from "hono";
import { validator } from "hono/validator";
import type { AuthEnvironment } from "./auth";
import { z } from "zod";
import { ImageUploadApi } from "../api/image-uploads";
import { ApiValidation } from "../api/validation";
import { Scope } from "../api/scope";
import type { ImageStorage } from "../services/image-storage";
import type { ScopeMiddleware } from "./scope";

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

export class PhotoUploadRoutes extends Hono<AuthEnvironment> {
    constructor(access: ScopeMiddleware, getStorage: () => ImageStorage) {
        super();
        this.post(
            "/",
            access.write(ImageUploadApi.create),
            validator("json", (value) =>
                UploadValidation.uploadRequest.parse(value),
            ),
            async (context) => {
                const upload = await ImageUploadApi.create(
                    context.var.db,
                    getStorage(),
                    context.req.valid("json").contentType,
                    context.var.authIdentity,
                );
                context.header("Location", `/photo-uploads/${upload.id}`);
                return context.json(upload, 201);
            },
        );
        this.get(
            "/:uploadId",
            access.require(Scope.PhotosCreate),
            async (context) => {
                return context.json(
                    await ImageUploadApi.read(
                        context.var.db,
                        ApiValidation.uuid.parse(context.req.param("uploadId")),
                        context.var.authIdentity,
                    ),
                );
            },
        );
        this.get(
            "/:uploadId/assets/:filename",
            access.require(Scope.PhotosCreate),
            async (context) => {
                const stored = await ImageUploadApi.readAsset(
                    context.var.db,
                    getStorage(),
                    ApiValidation.uuid.parse(context.req.param("uploadId")),
                    context.req.param("filename"),
                    context.var.authIdentity,
                );
                if ("url" in stored) return context.redirect(stored.url, 302);
                return new Response(stored.file.stream(), {
                    headers: { "Content-Type": stored.file.type },
                });
            },
        );
        this.post(
            "/:uploadId/complete",
            access.require(Scope.PhotosCreate),
            async (context) => {
                return context.json(
                    await ImageUploadApi.finish(
                        context.var.db,
                        getStorage(),
                        ApiValidation.uuid.parse(context.req.param("uploadId")),
                        context.var.authIdentity,
                    ),
                );
            },
        );
        this.post(
            "/:uploadId/cancel",
            access.require(Scope.PhotosCreate),
            async (context) => {
                return context.json(
                    await ImageUploadApi.cancel(
                        context.var.db,
                        ApiValidation.uuid.parse(context.req.param("uploadId")),
                        context.var.authIdentity,
                    ),
                );
            },
        );
    }
}

export class ImageUploadRoutes extends Hono<AuthEnvironment> {
    constructor(access: ScopeMiddleware, getStorage: () => ImageStorage) {
        super();
        this.post(
            "/:id/uploads",
            access.write(ImageUploadApi.replace),
            validator("json", (value) =>
                UploadValidation.uploadRequest.parse(value),
            ),
            async (context) => {
                const id = ApiValidation.uuid.parse(context.req.param("id"));
                const upload = await ImageUploadApi.replace(
                    context.var.db,
                    getStorage(),
                    id,
                    context.req.valid("json").contentType,
                    context.var.authIdentity,
                );
                context.header(
                    "Location",
                    `/photos/${id.toLowerCase()}/uploads/${upload.id}`,
                );
                return context.json(upload, 201);
            },
        );
        this.get(
            "/:id/uploads/:uploadId",
            access.require(Scope.PhotosAssetsWrite),
            async (context) => {
                const id = ApiValidation.uuid.parse(context.req.param("id"));
                const uploadId = ApiValidation.uuid.parse(
                    context.req.param("uploadId"),
                );
                return context.json(
                    await ImageUploadApi.read(
                        context.var.db,
                        uploadId,
                        context.var.authIdentity,
                        id,
                    ),
                );
            },
        );
        this.post(
            "/:id/uploads/:uploadId/complete",
            access.require(Scope.PhotosAssetsWrite),
            async (context) => {
                const id = ApiValidation.uuid.parse(context.req.param("id"));
                const uploadId = ApiValidation.uuid.parse(
                    context.req.param("uploadId"),
                );
                return context.json(
                    await ImageUploadApi.finish(
                        context.var.db,
                        getStorage(),
                        uploadId,
                        context.var.authIdentity,
                        id,
                    ),
                );
            },
        );
        this.post(
            "/:id/uploads/:uploadId/cancel",
            access.require(Scope.PhotosAssetsWrite),
            async (context) => {
                const id = ApiValidation.uuid.parse(context.req.param("id"));
                const uploadId = ApiValidation.uuid.parse(
                    context.req.param("uploadId"),
                );
                return context.json(
                    await ImageUploadApi.cancel(
                        context.var.db,
                        uploadId,
                        context.var.authIdentity,
                        id,
                    ),
                );
            },
        );
    }
}
