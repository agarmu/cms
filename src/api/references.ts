import type { SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { ReadDatabase } from "./database";
import { ConflictError } from "../lib/errors";

export async function requireReference(
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

export async function preventReferencedDeletion(
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
