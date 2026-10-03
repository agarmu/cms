import type { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

export function createDatabase(client: SQL) {
    return drizzle(client, { schema });
}
