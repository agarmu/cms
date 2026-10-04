import { preventReferencedDeletion } from "../references";
import * as validation from "../validation";
import type { UUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { lenses, images } from "../../db/schema";
import type { NewLens } from "../../db/schema";
import type { Database, ReadDatabase } from "../database";
import type { Changes, Page } from "../types";
import { scoped } from "../call";
import { Scope } from "../scope";

export class LensApi {
    @scoped(Scope.LensesRead)
    static async list(db: ReadDatabase, page: Page) {
        const { limit, offset } = validation.pagination.parse(page);
        return db
            .select()
            .from(lenses)
            .orderBy(asc(lenses.id))
            .limit(limit)
            .offset(offset)
            .execute();
    }

    @scoped(Scope.LensesRead)
    static async read(db: ReadDatabase, id: UUID) {
        id = validation.uuid.parse(id);
        return db.select().from(lenses).where(eq(lenses.id, id)).execute();
    }

    @scoped(Scope.LensesWrite)
    static async create(db: Database, value: Omit<NewLens, "id">) {
        value = validation.equipment.parse(value);
        return db.insert(lenses).values(value).returning().execute();
    }

    @scoped(Scope.LensesWrite)
    static async update(db: Database, id: UUID, value: Changes<NewLens>) {
        value = validation.equipmentChanges.parse(value);
        id = validation.uuid.parse(id);
        return db
            .update(lenses)
            .set(value)
            .where(eq(lenses.id, id))
            .returning()
            .execute();
    }

    @scoped(Scope.LensesWrite)
    static async remove(db: Database, id: UUID) {
        id = validation.uuid.parse(id);
        await preventReferencedDeletion(
            db,
            images,
            eq(images.lensId, id),
            "lenses",
        );
        return db.delete(lenses).where(eq(lenses.id, id)).returning().execute();
    }
}
