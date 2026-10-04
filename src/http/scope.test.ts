import { expect, test } from "bun:test";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/bun-sql";
import { Scope } from "../api/scope";
import * as schema from "../db/schema";
import { scopeWrapper } from "./scope";

const db = drizzle.mock({ schema });
const withScope = scopeWrapper(db);

test("read scopes receive a database object with no write methods", async () => {
    const app = new Hono();
    app.get(
        "/",
        withScope(Scope.ImagesRead, (database, context) => {
            expect(database).not.toBe(db);
            expect(Object.isFrozen(database)).toBe(true);
            expect("insert" in database).toBe(false);
            expect("update" in database).toBe(false);
            expect("delete" in database).toBe(false);
            expect("execute" in database).toBe(false);
            expect("transaction" in database).toBe(false);
            database.select().from(schema.images).toSQL();
            return Promise.resolve(context.json({ readable: true }));
        }),
    );
    expect((await app.request("/")).status).toBe(200);
});

test("write scopes receive the writable database", async () => {
    const app = new Hono();
    app.post(
        "/",
        withScope(Scope.ImagesWrite, (database, context) => {
            expect(database).toBe(db);
            database.delete(schema.images).toSQL();
            return Promise.resolve(context.json({ writable: true }));
        }),
    );
    expect((await app.request("/", { method: "POST" })).status).toBe(200);
});
