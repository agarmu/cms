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
import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { drizzle } from "drizzle-orm/bun-sql";
import { Scope } from "../api/scope";
import { DatabaseSchema as schema } from "../db/schema";
import { HttpAccess } from "./scope";
import { HttpAuthentication } from "./auth";
import { requestAsUser, testAuthDependencies } from "../auth/test-fixtures";

const db = drizzle.mock({ schema: schema.definition });
const auth = new HttpAuthentication(
    testAuthDependencies.authentication,
    testAuthDependencies.allowedSubjects,
);
const access = new HttpAccess(db, auth);

test("read scopes receive a database object with no write methods", async () => {
    const app = new Elysia()
        .use(auth.plugin)
        .use(access.plugin)
        .get(
            "/",
            ({ db: database }) => {
                expect(database).not.toBe(db);
                expect(Object.isFrozen(database)).toBe(true);
                expect("insert" in database).toBe(false);
                expect("update" in database).toBe(false);
                expect("delete" in database).toBe(false);
                expect("execute" in database).toBe(false);
                expect("transaction" in database).toBe(false);
                database.select().from(schema.photos).toSQL();
                return { readable: true };
            },
            { read: Scope.PhotosRead },
        );
    expect((await requestAsUser(app, "/")).status).toBe(200);
});

test("write scopes receive the writable database", async () => {
    const app = new Elysia()
        .use(auth.plugin)
        .use(access.plugin)
        .post(
            "/",
            ({ db: database }) => {
                expect(database).toBe(db);
                database.delete(schema.photos).toSQL();
                return { writable: true };
            },
            { write: Scope.PhotosCreate },
        );
    expect((await requestAsUser(app, "/", { method: "POST" })).status).toBe(
        200,
    );
});
