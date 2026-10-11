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
import { requestApp } from "../auth/test-fixtures";
import { expect, test } from "bun:test";
import { Elysia, status } from "elysia";
import { z } from "zod";
import { ConflictError } from "../lib/errors";
import { HttpErrorHandler } from "./errors";

function failingApp(error: Error) {
    const reported: Error[] = [];
    const app = new Elysia();
    app.use(new HttpErrorHandler((failure) => reported.push(failure)).plugin);
    app.get("/", () => {
        throw error;
    });
    return { app, reported };
}

test("unexpected errors are reported without exposing their message or cause", async () => {
    const error = new Error("Private database details", {
        cause: new Error("Private cause"),
    });
    const { app, reported } = failingApp(error);
    const response = await requestApp(app, "/");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
    expect(reported).toEqual([error]);
});

test("API conflicts expose the intended message but keep the cause private", async () => {
    const { app, reported } = failingApp(
        new ConflictError("Image is still referenced", {
            cause: new Error("Private cause"),
        }),
    );
    const response = await requestApp(app, "/");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
        error: "Image is still referenced",
    });
    expect(reported).toEqual([]);
});

test.each(["23503", "23505", "23514", "23502"])(
    "database constraint %s remains handled for concurrent writes",
    async (code) => {
        const { app, reported } = failingApp(
            new Error("Private query", { cause: { code } }),
        );
        const response = await requestApp(app, "/");
        expect(response.status).toBe(
            code === "23503" || code === "23505" ? 409 : 400,
        );
        expect(await response.text()).not.toContain("Private query");
        expect(reported).toEqual([]);
    },
);

test("validation errors expose issues with a 400 response", async () => {
    const result = z.object({ name: z.string() }).safeParse({ name: null });
    if (result.success) throw new Error("Expected invalid input");
    const { app, reported } = failingApp(result.error);
    const response = await requestApp(app, "/");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
        error: "Invalid request",
        issues: [{ path: ["name"] }],
    });
    expect(reported).toEqual([]);
});

test("explicit HTTP statuses preserve response headers", async () => {
    const app = new Elysia()
        .use(
            new HttpErrorHandler(() => {
                throw new Error("Unexpected error");
            }).plugin,
        )
        .get("/", ({ set }) => {
            set.headers["Retry-After"] = "30";
            return status(429, "Try later");
        });
    const response = await requestApp(app, "/");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(await response.text()).toBe("Try later");
});
