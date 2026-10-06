import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import { PhotoApi } from "../api/photos";
import type { ScopeMiddleware } from "./scope";
import type { AuthEnvironment } from "./auth";
import { HttpValidation as validation } from "./validation";
import { ImageStorage } from "../services/image-storage";
import { Tracing } from "../telemetry/tracing";

export class PhotoRoutes extends Hono<AuthEnvironment> {
    constructor(access: ScopeMiddleware, getStorage: () => ImageStorage) {
        super();
        this.get("/", access.read(PhotoApi.list), async (context) => {
            const db = context.var.db;
            return context.json(
                await PhotoApi.list(
                    db,
                    validation.pagination.parse(context.req.query()),
                ),
            );
        });
        this.get(
            "/:id/metadata",
            access.read(PhotoApi.read),
            async (context) => {
                const db = context.var.db;
                return context.json(
                    await PhotoApi.read(
                        db,
                        validation.uuid.parse(context.req.param("id")),
                    ),
                );
            },
        );
        this.get("/:id", access.read(PhotoApi.read), async (context) => {
            const db = context.var.db;
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
                ImageStorage.assetUrl(photo.id, asset.assetLocation),
                302,
            );
        });
        this.get(
            "/:id/:filename",
            access.read(PhotoApi.read),
            async (context) => {
                const db = context.var.db;
                const id = validation.uuid.parse(context.req.param("id"));
                const filename = context.req.param("filename");
                const photo = await PhotoApi.read(db, id);
                if (
                    !filename ||
                    !photo.assets.some(
                        (asset) => asset.assetLocation === filename,
                    )
                ) {
                    throw new HTTPException(404, {
                        message: "Image asset not found",
                    });
                }
                const stored = await getStorage().read(photo.id, filename);
                if (!stored)
                    throw new HTTPException(404, {
                        message: "Image asset not found",
                    });
                if ("url" in stored) return context.redirect(stored.url, 302);
                return new Response(
                    Tracing.tracedStream("image.asset.download", () =>
                        stored.file.stream(),
                    ),
                    {
                        headers: { "Content-Type": stored.file.type },
                    },
                );
            },
        );
        this.post(
            "/",
            access.write(PhotoApi.create),
            validator("json", (value) => validation.photo.parse(value)),
            async (context) => {
                const db = context.var.db;
                return context.json(
                    await PhotoApi.create(db, context.req.valid("json")),
                    201,
                );
            },
        );
        this.patch(
            "/:id",
            access.write(PhotoApi.update),
            validator("json", (value) => validation.photoChanges.parse(value)),
            async (context) => {
                const db = context.var.db;
                const id = validation.uuid.parse(context.req.param("id"));
                return context.json(
                    await PhotoApi.update(db, id, context.req.valid("json")),
                );
            },
        );
        this.delete("/:id", access.write(PhotoApi.remove), async (context) => {
            const db = context.var.db;
            await PhotoApi.remove(
                db,
                validation.uuid.parse(context.req.param("id")),
            );
            return context.body(null, 204);
        });
    }
}
