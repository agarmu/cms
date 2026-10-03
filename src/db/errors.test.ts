import { expect, test } from "bun:test";
import { SQL } from "bun";
import { constraintStatus } from "./errors";

test("recognizes Bun SQL constraint errors wrapped by Drizzle", () => {
    const cause = new SQL.PostgresError("Foreign key violation", {
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "23503",
    });
    expect(constraintStatus(new Error("Query failed", { cause }))).toBe(409);
});

test("recognizes PGlite constraint errors wrapped by Drizzle", () => {
    const cause = Object.assign(new Error("Check violation"), {
        code: "23514",
    });
    expect(constraintStatus(new Error("Query failed", { cause }))).toBe(400);
});

test("does not classify connection failures as constraint errors", () => {
    const cause = new SQL.PostgresError("Connection refused", {
        code: "ERR_POSTGRES_CONNECTION_REFUSED",
    });
    expect(
        constraintStatus(new Error("Query failed", { cause })),
    ).toBeUndefined();
});
