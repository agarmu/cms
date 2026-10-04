import type { UUID } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import { images } from "../../db/schema";
import type { NewImage } from "../../db/schema";
import type { Database, ReadDatabase } from "../database";
import type { Changes, Page } from "../types";
import { scoped } from "../call";
import { Scope } from "../scope";

export class ImageApi {
    @scoped(Scope.ImagesRead)
    static list(db: ReadDatabase, { limit, offset }: Page) {
        return db
            .select()
            .from(images)
            .orderBy(desc(images.posted), asc(images.id))
            .limit(limit)
            .offset(offset)
            .execute();
    }

    @scoped(Scope.ImagesRead)
    static read(db: ReadDatabase, id: UUID) {
        return db.select().from(images).where(eq(images.id, id)).execute();
    }

    @scoped(Scope.ImagesWrite)
    static create(db: Database, value: Omit<NewImage, "id">) {
        return db.insert(images).values(value).returning().execute();
    }

    @scoped(Scope.ImagesWrite)
    static update(db: Database, id: UUID, value: Changes<NewImage>) {
        return db
            .update(images)
            .set(value)
            .where(eq(images.id, id))
            .returning()
            .execute();
    }

    @scoped(Scope.ImagesWrite)
    static remove(db: Database, id: UUID) {
        return db.delete(images).where(eq(images.id, id)).returning().execute();
    }
}
