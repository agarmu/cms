import { HTTPException } from "hono/http-exception";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type { Context, Env } from "hono";
import { z } from "zod";
import { getScope } from "../api/call";
import { InvalidUploadTokenError, ImageUploadApi } from "../api/image-uploads";
import { uuid } from "../api/validation";
import {
    InvalidImageError,
    ImageTooLargeError,
} from "../services/image-storage";
import type { ImageStorage } from "../services/image-storage";
import type { ScopeWrapper } from "./scope";

const uploadRequest = z.strictObject({
    contentType: z.enum([
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/avif",
        "image/tiff",
    ]),
});
const cancelRequest = z.strictObject({
    token: z.string().regex(/^[a-f0-9]{64}$/),
});
const interruptRequest = cancelRequest.extend({ ready: z.boolean() });
type ControlContext<Schema extends z.ZodType> = Context<
    Env,
    string,
    { out: { json: z.output<Schema> } }
>;
type UploadContext = Context<
    Env,
    string,
    { out: { json: z.output<typeof uploadRequest> } }
>;

export function imageUploadRoutes(
    withScope: ScopeWrapper,
    getStorage: () => ImageStorage,
) {
    const routes = new Hono();
    routes.post(
        "/:id/upload",
        validator("json", (value) => uploadRequest.parse(value)),
        withScope(
            getScope(ImageUploadApi.create, "write"),
            async (db, context: UploadContext) => {
                const id = uuid.parse(context.req.param("id"));
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
    routes.get(
        "/:id/uploads/:uploadId",
        withScope(
            getScope(ImageUploadApi.read, "read"),
            async (db, context) => {
                const id = uuid.parse(context.req.param("id"));
                const uploadId = uuid.parse(context.req.param("uploadId"));
                return context.json(
                    await ImageUploadApi.read(db, id, uploadId),
                );
            },
        ),
    );
    routes.post(
        "/:id/uploads/:uploadId/interrupt",
        validator("json", (value) => interruptRequest.parse(value)),
        withScope(
            getScope(ImageUploadApi.interrupt, "write"),
            async (db, context: ControlContext<typeof interruptRequest>) => {
                const id = uuid.parse(context.req.param("id"));
                const uploadId = uuid.parse(context.req.param("uploadId"));
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
                    throw controlError(error);
                }
            },
        ),
    );
    routes.delete(
        "/:id/uploads/:uploadId",
        validator("json", (value) => cancelRequest.parse(value)),
        withScope(
            getScope(ImageUploadApi.cancel, "write"),
            async (db, context: ControlContext<typeof cancelRequest>) => {
                const id = uuid.parse(context.req.param("id"));
                const uploadId = uuid.parse(context.req.param("uploadId"));
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
                    throw controlError(error);
                }
            },
        ),
    );
    return routes;
}

function controlError(error: unknown) {
    if (error instanceof InvalidUploadTokenError)
        return new HTTPException(403, { message: error.message });
    if (error instanceof InvalidImageError)
        return new HTTPException(400, { message: error.message });
    if (error instanceof ImageTooLargeError)
        return new HTTPException(413, { message: error.message });
    return error;
}
