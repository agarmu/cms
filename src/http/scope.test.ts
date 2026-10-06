import { expect, test } from "bun:test";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/bun-sql";
import { Scope } from "../api/scope";
import { DatabaseSchema as schema } from "../db/schema";
import { ScopeMiddleware } from "./scope";
import { AuthenticationMiddleware } from "./auth";
import type { AuthEnvironment } from "./auth";
import { requestAsUser, testAuthDependencies } from "../auth/test-fixtures";

const db = drizzle.mock({ schema: schema.definition });
const access = new ScopeMiddleware(db);

test("read scopes receive a database object with no write methods", async () => {
    const app = new Hono<AuthEnvironment>();
    app.use(
        "*",
        new AuthenticationMiddleware(
            testAuthDependencies.authentication,
            testAuthDependencies.allowedSubjects,
        ).handle,
    );
    app.get("/", access.require(Scope.PhotosRead), (context) => {
        const database = context.var.db;
        expect(database).not.toBe(db);
        expect(Object.isFrozen(database)).toBe(true);
        expect("insert" in database).toBe(false);
        expect("update" in database).toBe(false);
        expect("delete" in database).toBe(false);
        expect("execute" in database).toBe(false);
        expect("transaction" in database).toBe(false);
        database.select().from(schema.images).toSQL();
        return context.json({ readable: true });
    });
    expect((await requestAsUser(app, "/")).status).toBe(200);
});

test("write scopes receive the writable database", async () => {
    const app = new Hono<AuthEnvironment>();
    app.use(
        "*",
        new AuthenticationMiddleware(
            testAuthDependencies.authentication,
            testAuthDependencies.allowedSubjects,
        ).handle,
    );
    app.post("/", access.require(Scope.PhotosCreate), (context) => {
        const database = context.var.db;
        expect(database).toBe(db);
        database.delete(schema.images).toSQL();
        return context.json({ writable: true });
    });
    expect((await requestAsUser(app, "/", { method: "POST" })).status).toBe(
        200,
    );
});
