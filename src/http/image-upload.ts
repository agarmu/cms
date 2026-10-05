import { HTTPException } from "hono/http-exception";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type { Context, Env } from "hono";
import { z } from "zod";
import { ApiScope } from "../api/call";
import { InvalidUploadTokenError, ImageUploadApi } from "../api/image-uploads";
import { ApiValidation } from "../api/validation";
import {
    InvalidImageError,
    ImageTooLargeError,
} from "../services/image-storage";
import type { ImageStorage } from "../services/image-storage";
import type { ScopeWrapper } from "./scope";

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
type ControlContext<Schema extends z.ZodType> = Context<
    Env,
    string,
    { out: { json: z.output<Schema> } }
>;
type UploadContext = Context<
    Env,
    string,
    { out: { json: z.output<typeof UploadValidation.uploadRequest> } }
>;

export class ImageUploadRoutes extends Hono {
    constructor(withScope: ScopeWrapper, getStorage: () => ImageStorage) {
        super();
        this.post(
            "/:id/upload",
            validator("json", (value) =>
                UploadValidation.uploadRequest.parse(value),
            ),
            withScope(
                ApiScope.getScope(ImageUploadApi.create, "write"),
                async (db, context: UploadContext) => {
                    const id = ApiValidation.uuid.parse(
                        context.req.param("id"),
                    );
                    const upload = await ImageUploadApi.create(
                        db,
                        getStorage(),
                        id,
                        context.req.valid("json").contentType,
                    );
                    return context.json(upload, 201);
                },
            ),
        );
        this.get(
            "/:id/uploads/:uploadId",
            withScope(
                ApiScope.getScope(ImageUploadApi.read, "read"),
                async (db, context) => {
                    const id = ApiValidation.uuid.parse(
                        context.req.param("id"),
                    );
                    const uploadId = ApiValidation.uuid.parse(
                        context.req.param("uploadId"),
                    );
                    return context.json(
                        await ImageUploadApi.read(db, id, uploadId),
                    );
                },
            ),
        );
        this.post(
            "/:id/uploads/:uploadId/interrupt",
            validator("json", (value) =>
                UploadValidation.interruptRequest.parse(value),
            ),
            withScope(
                ApiScope.getScope(ImageUploadApi.interrupt, "write"),
                async (
                    db,
                    context: ControlContext<
                        typeof UploadValidation.interruptRequest
                    >,
                ) => {
                    const id = ApiValidation.uuid.parse(
                        context.req.param("id"),
                    );
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
            ),
        );
        this.delete(
            "/:id/uploads/:uploadId",
            validator("json", (value) =>
                UploadValidation.cancelRequest.parse(value),
            ),
            withScope(
                ApiScope.getScope(ImageUploadApi.cancel, "write"),
                async (
                    db,
                    context: ControlContext<
                        typeof UploadValidation.cancelRequest
                    >,
                ) => {
                    const id = ApiValidation.uuid.parse(
                        context.req.param("id"),
                    );
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
            ),
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
