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
import { asc, eq } from "drizzle-orm";
import { DatabaseSchema } from "../../db/schema";
import type { NewImageAsset } from "../../db/schema";
import type { Database, ReadDatabase } from "../database";
import type { Changes, Page } from "../types";
import { ApiScope } from "../call";
import { Scope } from "../scope";

export class ImageAssetApi {
    @ApiScope.scoped(Scope.ImageAssetsRead)
    @Tracing.traced("image-assets.list")
    static async list(db: ReadDatabase, page: Page) {
        const { limit, offset } = validation.pagination.parse(page);
        return db
            .select()
            .from(DatabaseSchema.imageAssets)
            .orderBy(asc(DatabaseSchema.imageAssets.id))
            .limit(limit)
            .offset(offset)
            .execute();
    }

    @ApiScope.scoped(Scope.ImageAssetsRead)
    @Tracing.traced("image-assets.read")
    static async read(db: ReadDatabase, id: number) {
        id = validation.assetId.parse(id);
        return db
            .select()
            .from(DatabaseSchema.imageAssets)
            .where(eq(DatabaseSchema.imageAssets.id, id))
            .execute();
    }

    @ApiScope.scoped(Scope.ImageAssetsWrite)
    @Tracing.traced("image-assets.create")
    static async create(db: Database, value: Omit<NewImageAsset, "id">) {
        value = validation.imageAsset.parse(value);
        if (value.photoId !== undefined)
            await References.requireReference(
                db,
                DatabaseSchema.photos,
                eq(DatabaseSchema.photos.id, value.photoId),
                "photoId",
            );
        return db
            .insert(DatabaseSchema.imageAssets)
            .values(value)
            .returning()
            .execute();
    }

    @ApiScope.scoped(Scope.ImageAssetsWrite)
    @Tracing.traced("image-assets.update")
    static async update(
        db: Database,
        id: number,
        value: Changes<NewImageAsset>,
    ) {
        value = validation.imageAssetChanges.parse(value);
        id = validation.assetId.parse(id);
        if (value.photoId !== undefined)
            await References.requireReference(
                db,
                DatabaseSchema.photos,
                eq(DatabaseSchema.photos.id, value.photoId),
                "photoId",
            );
        return db
            .update(DatabaseSchema.imageAssets)
            .set(value)
            .where(eq(DatabaseSchema.imageAssets.id, id))
            .returning()
            .execute();
    }

    @ApiScope.scoped(Scope.ImageAssetsWrite)
    @Tracing.traced("image-assets.remove")
    static async remove(db: Database, id: number) {
        id = validation.assetId.parse(id);
        return db
            .delete(DatabaseSchema.imageAssets)
            .where(eq(DatabaseSchema.imageAssets.id, id))
            .returning()
            .execute();
    }
}
