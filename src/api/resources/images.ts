import { requireReference, preventReferencedDeletion } from "../references";
import * as validation from "../validation";
import type { UUID } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import { images, cameras, lenses, imageAssets } from "../../db/schema";
import type { NewImage } from "../../db/schema";
import type { Database, ReadDatabase } from "../database";
import type { Changes, Page } from "../types";
import { scoped } from "../call";
import { Scope } from "../scope";

export class ImageApi {
    @scoped(Scope.ImagesRead)
    static async list(db: ReadDatabase, page: Page) {
        const { limit, offset } = validation.pagination.parse(page);
        return db
            .select()
            .from(images)
            .orderBy(desc(images.posted), asc(images.id))
            .limit(limit)
            .offset(offset)
            .execute();
    }

    @scoped(Scope.ImagesRead)
    static async read(db: ReadDatabase, id: UUID) {
        id = validation.uuid.parse(id);
        return db.select().from(images).where(eq(images.id, id)).execute();
    }

    @scoped(Scope.ImagesWrite)
    static async create(db: Database, value: Omit<NewImage, "id">) {
        value = validation.image.parse(value);
        if (value.cameraId != null)
            await requireReference(
                db,
                cameras,
                eq(cameras.id, value.cameraId),
                "cameraId",
            );
        if (value.lensId != null)
            await requireReference(
                db,
                lenses,
                eq(lenses.id, value.lensId),
                "lensId",
            );
        return db.insert(images).values(value).returning().execute();
    }

    @scoped(Scope.ImagesWrite)
    static async update(db: Database, id: UUID, value: Changes<NewImage>) {
        value = validation.imageChanges.parse(value);
        id = validation.uuid.parse(id);
        if (value.cameraId != null)
            await requireReference(
                db,
                cameras,
                eq(cameras.id, value.cameraId),
                "cameraId",
            );
        if (value.lensId != null)
            await requireReference(
                db,
                lenses,
                eq(lenses.id, value.lensId),
                "lensId",
            );
        return db
            .update(images)
            .set(value)
            .where(eq(images.id, id))
            .returning()
            .execute();
    }

    @scoped(Scope.ImagesWrite)
    static async remove(db: Database, id: UUID) {
        id = validation.uuid.parse(id);
        await preventReferencedDeletion(
            db,
            imageAssets,
            eq(imageAssets.photoId, id),
            "Image",
        );
        return db.delete(images).where(eq(images.id, id)).returning().execute();
    }
}
