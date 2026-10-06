import { Hono } from "hono";
import { validator } from "hono/validator";
import type { AuthEnvironment } from "./auth";
import { z } from "zod";
import { ImageUploadApi } from "../api/image-uploads";
import { ApiValidation } from "../api/validation";
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
    static readonly controlRequest = z.strictObject({
        token: z.string().regex(/^[a-f0-9]{64}$/),
    });
}

export class ImageUploadRoutes extends Hono<AuthEnvironment> {
    constructor(access: ScopeMiddleware, getStorage: () => ImageStorage) {
        super();
        this.post(
            "/:id/uploads",
            access.write(ImageUploadApi.create),
            validator("json", (value) =>
                UploadValidation.uploadRequest.parse(value),
            ),
            async (context) => {
                const db = context.var.db;
                const id = ApiValidation.uuid.parse(context.req.param("id"));
                const upload = await ImageUploadApi.create(
                    db,
                    getStorage(),
                    id,
                    context.req.valid("json").contentType,
                );
                const { uploadId, token, url, method, headers, expiresIn } =
                    upload;
                context.header(
                    "Location",
                    `/photos/${id.toLowerCase()}/uploads/${uploadId}`,
                );
                return context.json(
                    {
                        id: uploadId,
                        status: "pending",
                        token,
                        upload: { url, method, headers, expiresIn },
                    },
                    201,
                );
            },
        );
        this.get(
            "/:id/uploads/:uploadId",
            access.read(ImageUploadApi.read),
            async (context) => {
                const db = context.var.db;
                const id = ApiValidation.uuid.parse(context.req.param("id"));
                const uploadId = ApiValidation.uuid.parse(
                    context.req.param("uploadId"),
                );
                return context.json(
                    await ImageUploadApi.read(db, id, uploadId),
                );
            },
        );
        this.post(
            "/:id/uploads/:uploadId/complete",
            access.write(ImageUploadApi.finish),
            validator("json", (value) =>
                UploadValidation.controlRequest.parse(value),
            ),
            async (context) => {
                const db = context.var.db;
                const id = ApiValidation.uuid.parse(context.req.param("id"));
                const uploadId = ApiValidation.uuid.parse(
                    context.req.param("uploadId"),
                );
                const { token } = context.req.valid("json");
                return context.json(
                    await ImageUploadApi.finish(
                        db,
                        getStorage(),
                        id,
                        uploadId,
                        token,
                    ),
                );
            },
        );
        this.post(
            "/:id/uploads/:uploadId/cancel",
            access.write(ImageUploadApi.cancel),
            validator("json", (value) =>
                UploadValidation.controlRequest.parse(value),
            ),
            async (context) => {
                const db = context.var.db;
                const id = ApiValidation.uuid.parse(context.req.param("id"));
                const uploadId = ApiValidation.uuid.parse(
                    context.req.param("uploadId"),
                );
                return context.json(
                    await ImageUploadApi.cancel(
                        db,
                        id,
                        uploadId,
                        context.req.valid("json").token,
                    ),
                );
            },
        );
    }
}
