import { expect, expectTypeOf, test } from "bun:test";
import { Elysia } from "elysia";
import { drizzle } from "drizzle-orm/bun-sql";
import type { UUID } from "node:crypto";
import { z } from "zod";
import { ApiValidation } from "../api/validation";
import { DatabaseSchema } from "../db/schema";
import { testAuthDependencies, requestApp } from "../auth/test-fixtures";
import { HttpApplication } from "./app";
import { HttpOpenApi } from "./openapi";
import { HttpErrorHandler } from "./errors";

const app = new HttpApplication({
    ...testAuthDependencies,
    db: drizzle.mock({ schema: DatabaseSchema.definition }),
    getImageStorage: () => {
        throw new Error("Documentation must not access storage");
    },
    reportError: (error) => {
        throw error;
    },
});
const document = (await (
    await requestApp(app, "/openapi.json")
).json()) as ReturnType<typeof HttpOpenApi.document>;

test("OpenAPI is public and describes every HTTP resource, without MCP or discovery routes", () => {
    const resources = app.app.routes.filter(
        (route) => route.path.startsWith("/api/") && !route.hooks.detail?.hide,
    );
    const operations = new Set<string>();
    for (const [path, item] of Object.entries(document.paths)) {
        for (const method of ["get", "post", "patch", "delete"] as const)
            if (item?.[method]) operations.add(`${method} ${path}`);
    }
    expect(operations).toEqual(
        new Set(
            resources.map(
                (route) =>
                    `${route.method.toLowerCase()} ${route.path.replace(/:([^/]+)/g, "{$1}")}`,
            ),
        ),
    );
    expect(document.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths["/api/photos"]?.get?.description).toContain(
        "photos:read",
    );
});

test("OpenAPI derives JSON inputs, UUIDs, dates, pagination bounds, and responses from route schemas", () => {
    expect(document.paths["/api/photos"]?.post?.requestBody).toMatchObject({
        content: {
            "application/json": {
                schema: {
                    required: expect.arrayContaining([
                        "uploadId",
                        "taken",
                        "posted",
                    ]),
                    properties: {
                        uploadId: { format: "uuid" },
                        taken: { format: "date-time" },
                    },
                },
            },
        },
    });
    expect(document.paths["/api/photos"]?.get?.parameters).toEqual(
        expect.arrayContaining([
            expect.objectContaining({
                name: "limit",
                schema: expect.objectContaining({
                    type: "integer",
                    minimum: 1,
                    maximum: 100,
                    default: 50,
                }),
            }),
        ]),
    );
    expect(document.paths["/api/photos/{id}"]?.get?.responses).toMatchObject({
        200: {
            content: {
                "application/json": {
                    schema: {
                        properties: {
                            id: { format: "uuid" },
                            taken: { format: "date-time" },
                        },
                    },
                },
            },
        },
        401: {
            content: {
                "application/json": { schema: { required: ["error"] } },
            },
        },
    });
});

test("empty and binary responses have their actual wire formats", () => {
    expect(
        document.paths["/api/photos/{id}"]?.delete?.responses["204"],
    ).not.toHaveProperty("content");
    for (const path of [
        "/api/photos/{id}/image",
        "/api/photos/{id}/assets/{filename}",
        "/api/photo-uploads/{uploadId}/assets/{filename}",
    ]) {
        expect(document.paths[path]?.get?.responses["200"]).toMatchObject({
            content: {
                "image/*": { schema: { type: "string", format: "binary" } },
                "application/json": {
                    schema: {
                        properties: {
                            url: { format: "uri" },
                            expiresAt: { format: "date-time" },
                        },
                    },
                },
            },
        });
    }
});

test("Elysia infers UUID values and rejects responses that violate a declared schema", async () => {
    const response = z.object({ id: ApiValidation.uuid });
    const errors: Error[] = [];
    const invalid = new Elysia()
        .use(new HttpErrorHandler((error) => errors.push(error)).plugin)
        .get(
            "/:id",
            ({ params }) => {
                expectTypeOf(params.id).toEqualTypeOf<UUID>();
                return { id: params.id };
            },
            { params: response, response },
        )
        .get(
            "/invalid",
            // @ts-expect-error A plain string is not a validated UUID.
            () => ({ id: "invalid" }),
            { response },
        );
    const rejected = await requestApp(invalid, "/invalid");
    expect(rejected.status).toBe(500);
    expect(await rejected.json()).toEqual({ error: "Internal server error" });
    expect(errors).toHaveLength(1);
    expect((await requestApp(invalid, `/${crypto.randomUUID()}`)).status).toBe(
        200,
    );
});

test("public documentation handles the trailing-slash alias without authentication", async () => {
    const response = await requestApp(app, "/openapi.json/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(document);
});
