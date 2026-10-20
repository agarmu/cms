import type { Database, ReadDatabase } from "../api/database";
import { DatabaseSchema } from "./schema";

export async function initializeDatabaseIdentity(db: Pick<Database, "insert">) {
    await db
        .insert(DatabaseSchema.databaseIdentity)
        .values({ singleton: true })
        .onConflictDoNothing({
            target: DatabaseSchema.databaseIdentity.singleton,
        });
}

export async function assertDemoDatabaseIsolation(
    primary: ReadDatabase,
    demo: ReadDatabase,
) {
    const [primaryRows, demoRows] = await Promise.all([
        primary.select().from(DatabaseSchema.databaseIdentity),
        demo.select().from(DatabaseSchema.databaseIdentity),
    ]);
    if (
        primaryRows.length !== 1 ||
        demoRows.length !== 1 ||
        !primaryRows[0]?.id ||
        !demoRows[0]?.id
    )
        throw new Error(
            "Cannot verify demo database isolation: missing database identity",
        );
    if (primaryRows[0].id === demoRows[0].id)
        throw new Error(
            "Demo database must be separate from the primary database",
        );
}
