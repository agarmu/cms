import { expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { ConflictError } from "../lib/errors";
import { errorHandler } from "./errors";

function failingApp(error: Error) {
    const reported: Error[] = [];
    const app = new Hono();
    app.onError(errorHandler((failure) => reported.push(failure)));
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
    const response = await app.request("/");
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
    const response = await app.request("/");
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
        const response = await app.request("/");
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
    const response = await app.request("/");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
        error: "Invalid request",
        issues: [{ path: ["name"] }],
    });
    expect(reported).toEqual([]);
});

test("HTTP exceptions preserve custom responses and headers", async () => {
    const { app } = failingApp(
        new HTTPException(429, {
            res: new Response("Try later", {
                status: 429,
                headers: { "Retry-After": "30" },
            }),
        }),
    );
    const response = await app.request("/");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(await response.text()).toBe("Try later");
});
