import type { UUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { lenses } from "../../db/schema";
import type { NewLens } from "../../db/schema";
import type { Database, ReadDatabase } from "../database";
import type { Changes, Page } from "../types";
import { scoped } from "../call";
import { Scope } from "../scope";

export class LensApi {
    @scoped(Scope.LensesRead)
    static list(db: ReadDatabase, { limit, offset }: Page) {
        return db
            .select()
            .from(lenses)
            .orderBy(asc(lenses.id))
            .limit(limit)
            .offset(offset)
            .execute();
    }

    @scoped(Scope.LensesRead)
    static read(db: ReadDatabase, id: UUID) {
        return db.select().from(lenses).where(eq(lenses.id, id)).execute();
    }

    @scoped(Scope.LensesWrite)
    static create(db: Database, value: Omit<NewLens, "id">) {
        return db.insert(lenses).values(value).returning().execute();
    }

    @scoped(Scope.LensesWrite)
    static update(db: Database, id: UUID, value: Changes<NewLens>) {
        return db
            .update(lenses)
            .set(value)
            .where(eq(lenses.id, id))
            .returning()
            .execute();
    }

    @scoped(Scope.LensesWrite)
    static remove(db: Database, id: UUID) {
        return db.delete(lenses).where(eq(lenses.id, id)).returning().execute();
    }
}
