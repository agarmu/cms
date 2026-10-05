import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { DatabaseSchema as schema } from "../db/schema";
import type { ReadScope, Scope } from "./scope";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema.definition>;
export type ReadDatabase = Readonly<Pick<Database, "select" | "query">>;
export type DatabaseFor<S extends Scope> = S extends ReadScope
    ? ReadDatabase
    : Database;
