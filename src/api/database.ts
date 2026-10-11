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
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { DatabaseSchema as schema } from "../db/schema";
import type { ReadScope, Scope } from "./scope";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema.definition>;
export type ReadDatabase = Readonly<Pick<Database, "select" | "query">>;
export type DatabaseFor<S extends Scope> = S extends ReadScope
    ? ReadDatabase
    : Database;
