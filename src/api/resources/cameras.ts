import { traced } from "../../telemetry/tracing";
import { preventReferencedDeletion } from "../references";
import * as validation from "../validation";
import type { UUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { cameras, images } from "../../db/schema";
import type { NewCamera } from "../../db/schema";
import type { Database, ReadDatabase } from "../database";
import type { Changes, Page } from "../types";
import { scoped } from "../call";
import { Scope } from "../scope";

export class CameraApi {
    @scoped(Scope.CamerasRead)
    @traced("cameras.list")
    static async list(db: ReadDatabase, page: Page) {
        const { limit, offset } = validation.pagination.parse(page);
        return db
            .select()
            .from(cameras)
            .orderBy(asc(cameras.id))
            .limit(limit)
            .offset(offset)
            .execute();
    }

    @scoped(Scope.CamerasRead)
    @traced("cameras.read")
    static async read(db: ReadDatabase, id: UUID) {
        id = validation.uuid.parse(id);
        return db.select().from(cameras).where(eq(cameras.id, id)).execute();
    }

    @scoped(Scope.CamerasWrite)
    @traced("cameras.create")
    static async create(db: Database, value: Omit<NewCamera, "id">) {
        value = validation.equipment.parse(value);
        return db.insert(cameras).values(value).returning().execute();
    }

    @scoped(Scope.CamerasWrite)
    @traced("cameras.update")
    static async update(db: Database, id: UUID, value: Changes<NewCamera>) {
        value = validation.equipmentChanges.parse(value);
        id = validation.uuid.parse(id);
        return db
            .update(cameras)
            .set(value)
            .where(eq(cameras.id, id))
            .returning()
            .execute();
    }

    @scoped(Scope.CamerasWrite)
    @traced("cameras.remove")
    static async remove(db: Database, id: UUID) {
        id = validation.uuid.parse(id);
        await preventReferencedDeletion(
            db,
            images,
            eq(images.cameraId, id),
            "cameras",
        );
        return db
            .delete(cameras)
            .where(eq(cameras.id, id))
            .returning()
            .execute();
    }
}
