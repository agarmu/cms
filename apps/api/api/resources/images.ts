// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
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
    @ApiScope.scoped(Scope.PhotosRead)
    @Tracing.traced("images.list")
    static async list(db: ReadDatabase, page: Page) {
        const { limit, offset } = validation.pagination.parse(page);
        return db
            .select()
            .from(DatabaseSchema.photos)
            .orderBy(
                desc(DatabaseSchema.photos.postedAt),
                asc(DatabaseSchema.photos.id),
            )
            .limit(limit)
            .offset(offset)
            .execute();
    }

    @ApiScope.scoped(Scope.PhotosRead)
    @Tracing.traced("images.read")
    static async read(db: ReadDatabase, id: UUID) {
        id = validation.uuid.parse(id);
        return db
            .select()
            .from(DatabaseSchema.photos)
            .where(eq(DatabaseSchema.photos.id, id))
            .execute();
    }

    @ApiScope.scoped(Scope.PhotosCreate)
    @Tracing.traced("images.create")
    static async create(db: Database, value: Omit<NewImage, "id">, id?: UUID) {
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
            .insert(DatabaseSchema.photos)
            .values({
                ...value,
                ...(id ? { id: validation.uuid.parse(id) } : {}),
            })
            .returning()
            .execute();
    }

    @ApiScope.scoped(Scope.PhotosMetadataUpdate)
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
            .update(DatabaseSchema.photos)
            .set(value)
            .where(eq(DatabaseSchema.photos.id, id))
            .returning()
            .execute();
    }

    @ApiScope.scoped(Scope.PhotosDelete)
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
            .delete(DatabaseSchema.photos)
            .where(eq(DatabaseSchema.photos.id, id))
            .returning()
            .execute();
    }
}
