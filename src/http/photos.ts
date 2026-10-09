import { PhotoAccess } from "../api/photo-access";
import { Scope } from "../api/scope";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import type { AuthEnvironment } from "./auth";
import { PhotoApi } from "../api/photos";
import { ImageUploadApi } from "../api/image-uploads";
import type { ScopeMiddleware } from "./scope";
import { HttpValidation as validation } from "./validation";
import type { ImageStorage } from "../services/image-storage";
import { downloadResponse, photoResponse } from "./response";

export class PhotoRoutes extends Hono<AuthEnvironment> {
    constructor(access: ScopeMiddleware, getStorage: () => ImageStorage) {
        super();
        this.get("/", access.read(PhotoApi.list), async (context) => {
            const db = context.var.db;
            const page = validation.pagination.parse(context.req.query());
            const items = await PhotoApi.list(db, page);
            return context.json({ items: items.map(photoResponse), ...page });
        });
        this.get("/:id", access.read(PhotoApi.read), async (context) => {
            const db = context.var.db;
            return context.json(
                photoResponse(
                    await PhotoApi.read(
                        db,
                        validation.uuid.parse(context.req.param("id")),
                    ),
                ),
            );
        });
        this.get("/:id/image", access.read(PhotoApi.read), async (context) => {
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
            const stored = await getStorage().read(
                photo.id,
                asset.assetLocation,
            );
            if (!stored)
                throw new HTTPException(404, {
                    message: "Image asset not found",
                });
            return downloadResponse(stored);
        });
        this.get(
            "/:id/assets/:filename",
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
                return downloadResponse(stored);
            },
        );
        this.post(
            "/",
            access.write(ImageUploadApi.createPhoto),
            validator("json", (value) => validation.photo.parse(value)),
            async (context) => {
                const db = context.var.db;
                const photo = await ImageUploadApi.createPhoto(
                    db,
                    context.req.valid("json"),
                    context.var.authIdentity,
                );
                context.header("Location", `/api/photos/${photo.id}`);
                return context.json(photo, 201);
            },
        );
        this.patch(
            "/:id",
            access.write(PhotoApi.update, Scope.PhotosTextUpdate),
            validator("json", (value) => validation.photoChanges.parse(value)),
            async (context) => {
                const db = context.var.db;
                const id = validation.uuid.parse(context.req.param("id"));
                const changes = context.req.valid("json");
                PhotoAccess.requireChanges(context.var.authIdentity, changes);
                return context.json(
                    photoResponse(await PhotoApi.update(db, id, changes)),
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
