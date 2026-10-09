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
                database.select().from(schema.images).toSQL();
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
                database.delete(schema.images).toSQL();
                return { writable: true };
            },
            { write: Scope.PhotosCreate },
        );
    expect((await requestAsUser(app, "/", { method: "POST" })).status).toBe(
        200,
    );
});
