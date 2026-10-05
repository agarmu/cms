import type { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { DatabaseSchema } from "./schema";

export class DatabaseFactory {
    static create(client: SQL) {
        return drizzle(client, { schema: DatabaseSchema.definition });
    }
}
