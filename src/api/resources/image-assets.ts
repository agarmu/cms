import { asc, eq } from "drizzle-orm";
import { imageAssets } from "../../db/schema";
import type { NewImageAsset } from "../../db/schema";
import type { Database, ReadDatabase } from "../database";
import type { Changes, Page } from "../types";
import { scoped } from "../call";
import { Scope } from "../scope";

export class ImageAssetApi {
    @scoped(Scope.ImageAssetsRead)
    static list(db: ReadDatabase, { limit, offset }: Page) {
        return db
            .select()
            .from(imageAssets)
            .orderBy(asc(imageAssets.id))
            .limit(limit)
            .offset(offset)
            .execute();
    }

    @scoped(Scope.ImageAssetsRead)
    static read(db: ReadDatabase, id: number) {
        return db
            .select()
            .from(imageAssets)
            .where(eq(imageAssets.id, id))
            .execute();
    }

    @scoped(Scope.ImageAssetsWrite)
    static create(db: Database, value: Omit<NewImageAsset, "id">) {
        return db.insert(imageAssets).values(value).returning().execute();
    }

    @scoped(Scope.ImageAssetsWrite)
    static update(db: Database, id: number, value: Changes<NewImageAsset>) {
        return db
            .update(imageAssets)
            .set(value)
            .where(eq(imageAssets.id, id))
            .returning()
            .execute();
    }

    @scoped(Scope.ImageAssetsWrite)
    static remove(db: Database, id: number) {
        return db
            .delete(imageAssets)
            .where(eq(imageAssets.id, id))
            .returning()
            .execute();
    }
}
