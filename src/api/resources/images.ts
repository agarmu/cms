import { Tracing } from "../../telemetry/tracing";
import { References } from "../references";
import { ApiValidation as validation } from "../validation";
import type { UUID } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import { DatabaseSchema } from "../../db/schema";
import type { NewImage } from "../../db/schema";
import type { Database, ReadDatabase } from "../database";
import type { Changes, Page } from "../types";
import { ApiScope } from "../call";
import { Scope } from "../scope";

export class ImageApi {
    @ApiScope.scoped(Scope.ImagesRead)
    @Tracing.traced("images.list")
    static async list(db: ReadDatabase, page: Page) {
        const { limit, offset } = validation.pagination.parse(page);
        return db
            .select()
            .from(DatabaseSchema.images)
            .orderBy(
                desc(DatabaseSchema.images.posted),
                asc(DatabaseSchema.images.id),
            )
            .limit(limit)
            .offset(offset)
            .execute();
    }

    @ApiScope.scoped(Scope.ImagesRead)
    @Tracing.traced("images.read")
    static async read(db: ReadDatabase, id: UUID) {
        id = validation.uuid.parse(id);
        return db
            .select()
            .from(DatabaseSchema.images)
            .where(eq(DatabaseSchema.images.id, id))
            .execute();
    }

    @ApiScope.scoped(Scope.ImagesWrite)
    @Tracing.traced("images.create")
    static async create(db: Database, value: Omit<NewImage, "id">) {
        value = validation.image.parse(value);
        if (value.cameraId != null)
            await References.requireReference(
                db,
                DatabaseSchema.cameras,
                eq(DatabaseSchema.cameras.id, value.cameraId),
                "cameraId",
            );
        if (value.lensId != null)
            await References.requireReference(
                db,
                DatabaseSchema.lenses,
                eq(DatabaseSchema.lenses.id, value.lensId),
                "lensId",
            );
        return db
            .insert(DatabaseSchema.images)
            .values(value)
            .returning()
            .execute();
    }

    @ApiScope.scoped(Scope.ImagesWrite)
    @Tracing.traced("images.update")
    static async update(db: Database, id: UUID, value: Changes<NewImage>) {
        value = validation.imageChanges.parse(value);
        id = validation.uuid.parse(id);
        if (value.cameraId != null)
            await References.requireReference(
                db,
                DatabaseSchema.cameras,
                eq(DatabaseSchema.cameras.id, value.cameraId),
                "cameraId",
            );
        if (value.lensId != null)
            await References.requireReference(
                db,
                DatabaseSchema.lenses,
                eq(DatabaseSchema.lenses.id, value.lensId),
                "lensId",
            );
        return db
            .update(DatabaseSchema.images)
            .set(value)
            .where(eq(DatabaseSchema.images.id, id))
            .returning()
            .execute();
    }

    @ApiScope.scoped(Scope.ImagesWrite)
    @Tracing.traced("images.remove")
    static async remove(db: Database, id: UUID) {
        id = validation.uuid.parse(id);
        await References.preventReferencedDeletion(
            db,
            DatabaseSchema.imageAssets,
            eq(DatabaseSchema.imageAssets.photoId, id),
            "Image",
        );
        return db
            .delete(DatabaseSchema.images)
            .where(eq(DatabaseSchema.images.id, id))
            .returning()
            .execute();
    }
}
