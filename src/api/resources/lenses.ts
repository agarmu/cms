import { Tracing } from "../../telemetry/tracing";
import { References } from "../references";
import { ApiValidation as validation } from "../validation";
import type { UUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { DatabaseSchema } from "../../db/schema";
import type { NewLens } from "../../db/schema";
import type { Database, ReadDatabase } from "../database";
import type { Changes, Page } from "../types";
import { ApiScope } from "../call";
import { Scope } from "../scope";

export class LensApi {
    @ApiScope.scoped(Scope.LensesRead)
    @Tracing.traced("lenses.list")
    static async list(db: ReadDatabase, page: Page) {
        const { limit, offset } = validation.pagination.parse(page);
        return db
            .select()
            .from(DatabaseSchema.lenses)
            .orderBy(asc(DatabaseSchema.lenses.id))
            .limit(limit)
            .offset(offset)
            .execute();
    }

    @ApiScope.scoped(Scope.LensesRead)
    @Tracing.traced("lenses.read")
    static async read(db: ReadDatabase, id: UUID) {
        id = validation.uuid.parse(id);
        return db
            .select()
            .from(DatabaseSchema.lenses)
            .where(eq(DatabaseSchema.lenses.id, id))
            .execute();
    }

    @ApiScope.scoped(Scope.LensesWrite)
    @Tracing.traced("lenses.create")
    static async create(db: Database, value: Omit<NewLens, "id">) {
        value = validation.equipment.parse(value);
        return db
            .insert(DatabaseSchema.lenses)
            .values(value)
            .returning()
            .execute();
    }

    @ApiScope.scoped(Scope.LensesWrite)
    @Tracing.traced("lenses.update")
    static async update(db: Database, id: UUID, value: Changes<NewLens>) {
        value = validation.equipmentChanges.parse(value);
        id = validation.uuid.parse(id);
        return db
            .update(DatabaseSchema.lenses)
            .set(value)
            .where(eq(DatabaseSchema.lenses.id, id))
            .returning()
            .execute();
    }

    @ApiScope.scoped(Scope.LensesWrite)
    @Tracing.traced("lenses.remove")
    static async remove(db: Database, id: UUID) {
        id = validation.uuid.parse(id);
        await References.preventReferencedDeletion(
            db,
            DatabaseSchema.images,
            eq(DatabaseSchema.images.lensId, id),
            "lenses",
        );
        return db
            .delete(DatabaseSchema.lenses)
            .where(eq(DatabaseSchema.lenses.id, id))
            .returning()
            .execute();
    }
}
