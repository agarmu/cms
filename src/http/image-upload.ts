import { HTTPException } from "hono/http-exception";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import { InvalidUploadTokenError, ImageUploadApi } from "../api/image-uploads";
import { ApiValidation } from "../api/validation";
import {
    InvalidImageError,
    ImageTooLargeError,
} from "../services/image-storage";
import type { ImageStorage } from "../services/image-storage";
import type { ScopeMiddleware } from "./scope";
import type { AuthEnvironment } from "./auth";

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
    static readonly cancelRequest = z.strictObject({
        token: z.string().regex(/^[a-f0-9]{64}$/),
    });
    static readonly interruptRequest = UploadValidation.cancelRequest.extend({
        ready: z.boolean(),
    });
}

export class ImageUploadRoutes extends Hono<AuthEnvironment> {
    constructor(access: ScopeMiddleware, getStorage: () => ImageStorage) {
        super();
        this.post(
            "/:id/upload",
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
                return context.json(upload, 201);
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
            "/:id/uploads/:uploadId/interrupt",
            access.write(ImageUploadApi.interrupt),
            validator("json", (value) =>
                UploadValidation.interruptRequest.parse(value),
            ),
            async (context) => {
                const db = context.var.db;
                const id = ApiValidation.uuid.parse(context.req.param("id"));
                const uploadId = ApiValidation.uuid.parse(
                    context.req.param("uploadId"),
                );
                const { token, ready } = context.req.valid("json");
                try {
                    return context.json(
                        await ImageUploadApi.interrupt(
                            db,
                            getStorage(),
                            id,
                            uploadId,
                            token,
                            ready,
                        ),
                    );
                } catch (error) {
                    throw ImageUploadRoutes.controlError(error);
                }
            },
        );
        this.delete(
            "/:id/uploads/:uploadId",
            access.write(ImageUploadApi.cancel),
            validator("json", (value) =>
                UploadValidation.cancelRequest.parse(value),
            ),
            async (context) => {
                const db = context.var.db;
                const id = ApiValidation.uuid.parse(context.req.param("id"));
                const uploadId = ApiValidation.uuid.parse(
                    context.req.param("uploadId"),
                );
                try {
                    return context.json(
                        await ImageUploadApi.cancel(
                            db,
                            id,
                            uploadId,
                            context.req.valid("json").token,
                        ),
                    );
                } catch (error) {
                    throw ImageUploadRoutes.controlError(error);
                }
            },
        );
    }

    private static controlError(error: unknown) {
        if (error instanceof InvalidUploadTokenError)
            return new HTTPException(403, { message: error.message });
        if (error instanceof InvalidImageError)
            return new HTTPException(400, { message: error.message });
        if (error instanceof ImageTooLargeError)
            return new HTTPException(413, { message: error.message });
        return error;
    }
}
