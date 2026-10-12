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
import type { SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { ReadDatabase } from "./database";
import { ConflictError } from "../lib/errors";

export class References {
    static async requireReference(
        db: ReadDatabase,
        table: PgTable,
        condition: SQL,
        field: string,
    ) {
        const rows = await db
            .select()
            .from(table)
            .where(condition)
            .limit(1)
            .execute();
        if (rows.length === 0)
            throw new ConflictError(
                `${field} references a record that does not exist`,
            );
    }

    static async preventReferencedDeletion(
        db: ReadDatabase,
        table: PgTable,
        condition: SQL,
        resource: string,
    ) {
        const rows = await db
            .select()
            .from(table)
            .where(condition)
            .limit(1)
            .execute();
        if (rows.length > 0)
            throw new ConflictError(
                `${resource} is still referenced by other records`,
            );
    }
}
