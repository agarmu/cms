import { traced } from "../../telemetry/tracing";
import { requireReference } from "../references";
import * as validation from "../validation";
import { asc, eq } from "drizzle-orm";
import { imageAssets, images } from "../../db/schema";
import type { NewImageAsset } from "../../db/schema";
import type { Database, ReadDatabase } from "../database";
import type { Changes, Page } from "../types";
import { scoped } from "../call";
import { Scope } from "../scope";

export class ImageAssetApi {
    @scoped(Scope.ImageAssetsRead)
    @traced("image-assets.list")
    static async list(db: ReadDatabase, page: Page) {
        const { limit, offset } = validation.pagination.parse(page);
        return db
            .select()
            .from(imageAssets)
            .orderBy(asc(imageAssets.id))
            .limit(limit)
            .offset(offset)
            .execute();
    }

    @scoped(Scope.ImageAssetsRead)
    @traced("image-assets.read")
    static async read(db: ReadDatabase, id: number) {
        id = validation.assetId.parse(id);
        return db
            .select()
            .from(imageAssets)
            .where(eq(imageAssets.id, id))
            .execute();
    }

    @scoped(Scope.ImageAssetsWrite)
    @traced("image-assets.create")
    static async create(db: Database, value: Omit<NewImageAsset, "id">) {
        value = validation.imageAsset.parse(value);
        if (value.photoId !== undefined)
            await requireReference(
                db,
                images,
                eq(images.id, value.photoId),
                "photoId",
            );
        return db.insert(imageAssets).values(value).returning().execute();
    }

    @scoped(Scope.ImageAssetsWrite)
    @traced("image-assets.update")
    static async update(
        db: Database,
        id: number,
        value: Changes<NewImageAsset>,
    ) {
        value = validation.imageAssetChanges.parse(value);
        id = validation.assetId.parse(id);
        if (value.photoId !== undefined)
            await requireReference(
                db,
                images,
                eq(images.id, value.photoId),
                "photoId",
            );
        return db
            .update(imageAssets)
            .set(value)
            .where(eq(imageAssets.id, id))
            .returning()
            .execute();
    }

    @scoped(Scope.ImageAssetsWrite)
    @traced("image-assets.remove")
    static async remove(db: Database, id: number) {
        id = validation.assetId.parse(id);
        return db
            .delete(imageAssets)
            .where(eq(imageAssets.id, id))
            .returning()
            .execute();
    }
}
