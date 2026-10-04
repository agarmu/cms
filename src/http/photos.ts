import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import type { Context, Env } from "hono";
import type { z } from "zod";
import { PhotoApi } from "../api/photos";
import { getScope } from "../api/call";
import type { ScopeWrapper } from "./scope";
import * as validation from "./validation";
import type { ImageStorage } from "../services/image-storage";
import { imageAssetUrl } from "../services/image-storage";

type PhotoContext<Schema extends z.ZodType> = Context<
    Env,
    string,
    { out: { json: z.output<Schema> } }
>;

export function photoRoutes(
    withScope: ScopeWrapper,
    getStorage: () => ImageStorage,
) {
    const routes = new Hono();
    routes.get(
        "/",
        withScope(getScope(PhotoApi.list, "read"), async (db, context) => {
            return context.json(
                await PhotoApi.list(
                    db,
                    validation.pagination.parse(context.req.query()),
                ),
            );
        }),
    );
    routes.get(
        "/:id/metadata",
        withScope(getScope(PhotoApi.read, "read"), async (db, context) => {
            return context.json(
                await PhotoApi.read(
                    db,
                    validation.uuid.parse(context.req.param("id")),
                ),
            );
        }),
    );
    routes.get(
        "/:id",
        withScope(getScope(PhotoApi.read, "read"), async (db, context) => {
            const id = validation.uuid.parse(context.req.param("id"));
            const photo = await PhotoApi.read(db, id);
            const asset = photo.assets.toSorted(
                (left, right) =>
                    right.width * right.height - left.width * left.height,
            )[0];
            if (!asset)
                throw new HTTPException(404, {
                    message: "Photo has no image assets",
                });
            return context.redirect(
                imageAssetUrl(id, asset.assetLocation),
                302,
            );
        }),
    );
    routes.get(
        "/:id/:filename",
        withScope(getScope(PhotoApi.read, "read"), async (db, context) => {
            const id = validation.uuid.parse(context.req.param("id"));
            const filename = context.req.param("filename");
            const photo = await PhotoApi.read(db, id);
            if (
                !filename ||
                !photo.assets.some((asset) => asset.assetLocation === filename)
            ) {
                throw new HTTPException(404, {
                    message: "Image asset not found",
                });
            }
            const stored = await getStorage().read(id, filename);
            if (!stored)
                throw new HTTPException(404, {
                    message: "Image asset not found",
                });
            if ("url" in stored) return context.redirect(stored.url, 302);
            return new Response(stored.file, {
                headers: {
                    "Content-Type": stored.file.type,
                    "Cache-Control": "public, max-age=31536000, immutable",
                },
            });
        }),
    );
    routes.post(
        "/",
        validator("json", (value) => validation.photo.parse(value)),
        withScope(
            getScope(PhotoApi.create, "write"),
            async (db, context: PhotoContext<typeof validation.photo>) => {
                return context.json(
                    await PhotoApi.create(db, context.req.valid("json")),
                    201,
                );
            },
        ),
    );
    routes.patch(
        "/:id",
        validator("json", (value) => validation.photoChanges.parse(value)),
        withScope(
            getScope(PhotoApi.update, "write"),
            async (
                db,
                context: PhotoContext<typeof validation.photoChanges>,
            ) => {
                const id = validation.uuid.parse(context.req.param("id"));
                return context.json(
                    await PhotoApi.update(db, id, context.req.valid("json")),
                );
            },
        ),
    );
    routes.delete(
        "/:id",
        withScope(getScope(PhotoApi.remove, "write"), async (db, context) => {
            await PhotoApi.remove(
                db,
                validation.uuid.parse(context.req.param("id")),
            );
            return context.body(null, 204);
        }),
    );
    return routes;
}
