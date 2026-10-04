import type { UUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { cameras } from "../../db/schema";
import type { NewCamera } from "../../db/schema";
import type { Database, ReadDatabase } from "../database";
import type { Changes, Page } from "../types";
import { scoped } from "../call";
import { Scope } from "../scope";

export class CameraApi {
    @scoped(Scope.CamerasRead)
    static list(db: ReadDatabase, { limit, offset }: Page) {
        return db
            .select()
            .from(cameras)
            .orderBy(asc(cameras.id))
            .limit(limit)
            .offset(offset)
            .execute();
    }

    @scoped(Scope.CamerasRead)
    static read(db: ReadDatabase, id: UUID) {
        return db.select().from(cameras).where(eq(cameras.id, id)).execute();
    }

    @scoped(Scope.CamerasWrite)
    static create(db: Database, value: Omit<NewCamera, "id">) {
        return db.insert(cameras).values(value).returning().execute();
    }

    @scoped(Scope.CamerasWrite)
    static update(db: Database, id: UUID, value: Changes<NewCamera>) {
        return db
            .update(cameras)
            .set(value)
            .where(eq(cameras.id, id))
            .returning()
            .execute();
    }

    @scoped(Scope.CamerasWrite)
    static remove(db: Database, id: UUID) {
        return db
            .delete(cameras)
            .where(eq(cameras.id, id))
            .returning()
            .execute();
    }
}
