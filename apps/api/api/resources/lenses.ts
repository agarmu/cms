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

    @ApiScope.scoped(Scope.LensesCreate)
    @Tracing.traced("lenses.create")
    static async create(db: Database, value: Omit<NewLens, "id">) {
        value = validation.equipment.parse(value);
        return db
            .insert(DatabaseSchema.lenses)
            .values(value)
            .returning()
            .execute();
    }

    @ApiScope.scoped(Scope.LensesUpdate)
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

    @ApiScope.scoped(Scope.LensesDelete)
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
