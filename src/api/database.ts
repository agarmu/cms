import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "../db/schema";
import type { ReadScope, Scope } from "./scope";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
export type ReadDatabase = Readonly<Pick<Database, "select" | "query">>;
export type DatabaseFor<S extends Scope> = S extends ReadScope
    ? ReadDatabase
    : Database;
