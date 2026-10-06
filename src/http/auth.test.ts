import { expect, test } from "bun:test";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/bun-sql";
import { Scope } from "../api/scope";
import { DatabaseSchema } from "../db/schema";
import {
    AuthenticationError,
    AuthenticationUnavailableError,
} from "../auth/provider";
import type { AuthenticationProvider } from "../auth/provider";
import { testAuthIdentity } from "../auth/test-fixtures";
import { HttpApplication } from "./app";
import { AuthenticationMiddleware } from "./auth";
import type { AuthEnvironment } from "./auth";
import { HttpErrorHandler } from "./errors";
import { ScopeMiddleware } from "./scope";

const db = drizzle.mock({ schema: DatabaseSchema.definition });
const reportedErrors: Error[] = [];
const providerBug = new TypeError("provider bug");
const outageCause = new Error("connection refused");
const authentication: AuthenticationProvider = {
    async authenticate(token) {
        if (token === "reader")
            return { ...testAuthIdentity, scopes: new Set([Scope.PhotosRead]) };
        if (token === "writer")
            return {
                ...testAuthIdentity,
                scopes: new Set([Scope.PhotosWrite]),
            };
        if (token === "stranger")
            return { ...testAuthIdentity, subject: "stranger" };
        if (token === "outage")
            throw new AuthenticationUnavailableError(outageCause);
        if (token === "bug") throw providerBug;
        throw new AuthenticationError();
    },
};
const app = new HttpApplication({
    db,
    authentication,
    allowedSubjects: [testAuthIdentity.subject],
    getImageStorage: () => {
        throw new Error("Unauthorized storage access");
    },
    reportError: (error) => {
        reportedErrors.push(error);
    },
});
const photoId = crypto.randomUUID();
const uploadId = crypto.randomUUID();
const metadata = {
    taken: "2026-10-02T12:00:00Z",
    posted: "2026-10-02T12:00:00Z",
    alt: "photo",
    description: "",
    enabled: true,
};
const routes: [string, string, unknown?][] = [
    ["GET", "/photos"],
    ["GET", `/photos/${photoId}`],
    ["GET", `/photos/${photoId}/image`],
    ["GET", `/photos/${photoId}/assets/original.webp`],
    ["POST", "/photos", metadata],
    ["PATCH", `/photos/${photoId}`, { alt: "changed" }],
    ["DELETE", `/photos/${photoId}`],
    ["POST", `/photos/${photoId}/uploads`, { contentType: "image/png" }],
    ["GET", `/photos/${photoId}/uploads/${uploadId}`],
    [
        "POST",
        `/photos/${photoId}/uploads/${uploadId}/complete`,
        { token: "a".repeat(64) },
    ],
    [
        "POST",
        `/photos/${photoId}/uploads/${uploadId}/cancel`,
        { token: "a".repeat(64) },
    ],
    ...["cameras", "lenses"].flatMap((resource): [string, string][] => [
        ["GET", `/${resource}`],
        ["GET", `/${resource}/${photoId}`],
        ["DELETE", `/${resource}/${photoId}`],
    ]),
];

test.each(routes)(
    "requires authentication on %s %s",
    async (method, path, body) => {
        const init: RequestInit = {
            method,
            headers: { "Content-Type": "application/json" },
        };
        if (body !== undefined) init.body = JSON.stringify(body);
        const response = await app.request(path, init);
        expect(response.status).toBe(401);
        expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    },
);

test.each(routes.filter(([method]) => method !== "GET"))(
    "read credentials cannot write through %s %s",
    async (method, path, body) => {
        const init: RequestInit = {
            method,
            headers: {
                Authorization: "Bearer reader",
                "Content-Type": "application/json",
            },
        };
        if (body !== undefined) init.body = JSON.stringify(body);
        const response = await app.request(path, init);
        expect(response.status).toBe(403);
        expect(response.headers.get("WWW-Authenticate")).toContain(
            'error="insufficient_scope"',
        );
    },
);

test.each([
    [
        "Bearer invalid",
        401,
        { error: "A valid bearer access token is required" },
    ],
    ["Bearer stranger", 403, { error: "Account is not authorized" }],
    [
        "Bearer outage",
        503,
        { error: "Authentication is temporarily unavailable" },
    ],
] as const)(
    "handles %s without calling the database",
    async (authorization, status, body) => {
        const response = await app.request("/photos", {
            headers: { authorization },
        });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(body);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    },
);

test("authenticates before parsing a request body", async () => {
    const response = await app.request("/photos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
    });
    expect(response.status).toBe(401);
});

test("checks exact scopes and passes AuthIdentity to permitted handlers", async () => {
    const scoped = new Hono<AuthEnvironment>();
    scoped.onError(
        new HttpErrorHandler((error) => {
            throw error;
        }).handle,
    );
    const access = new ScopeMiddleware(db);
    let writes = 0;
    scoped.use(
        "*",
        new AuthenticationMiddleware(authentication, [testAuthIdentity.subject])
            .handle,
    );
    scoped.get("/", access.require(Scope.PhotosRead), async (context) => {
        return context.json({ subject: context.get("authIdentity").subject });
    });
    scoped.post("/", access.require(Scope.PhotosWrite), async (context) => {
        writes++;
        return context.json({ saved: true });
    });
    const read = await scoped.request("/", {
        headers: { Authorization: "Bearer reader" },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ subject: "test-user" });
    expect(
        (
            await scoped.request("/", {
                method: "POST",
                headers: { Authorization: "Bearer reader" },
            })
        ).status,
    ).toBe(403);
    expect(writes).toBe(0);
    expect(
        (
            await scoped.request("/", {
                method: "POST",
                headers: { Authorization: "Bearer writer" },
            })
        ).status,
    ).toBe(200);
    expect(writes).toBe(1);
    expect(
        (
            await scoped.request("/", {
                headers: { Authorization: "Bearer writer" },
            })
        ).status,
    ).toBe(403);
});

test("scope checks fail closed if authentication middleware is missing", async () => {
    const scoped = new Hono<AuthEnvironment>();
    scoped.onError(
        new HttpErrorHandler((error) => {
            throw error;
        }).handle,
    );
    scoped.get(
        "/",
        new ScopeMiddleware(db).require(Scope.PhotosRead),
        async () => {
            throw new Error("Must not run");
        },
    );
    expect((await scoped.request("/")).status).toBe(401);
});

test("authenticated responses cannot opt into public caching", async () => {
    const scoped = new Hono<AuthEnvironment>();
    scoped.use(
        "*",
        new AuthenticationMiddleware(authentication, [testAuthIdentity.subject])
            .handle,
    );
    scoped.get(
        "/",
        () =>
            new Response("image", {
                headers: { "Cache-Control": "public, max-age=31536000" },
            }),
    );
    const response = await scoped.request("/", {
        headers: { Authorization: "Bearer reader" },
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});

test.each(routes.filter(([method]) => method !== "GET"))(
    "checks scopes before parsing malformed bodies on %s %s",
    async (method, path) => {
        const response = await app.request(path, {
            method,
            headers: {
                Authorization: "Bearer reader",
                "Content-Type": "application/json",
            },
            body: "{",
        });
        expect(response.status).toBe(403);
        expect(response.headers.get("WWW-Authenticate")).toContain(
            'error="insufficient_scope"',
        );
    },
);

test("reports provider outages with their cause and unexpected bugs as server errors", async () => {
    const outage = await app.request("/photos", {
        headers: { Authorization: "Bearer outage" },
    });
    expect(outage.status).toBe(503);
    expect(reportedErrors.at(-1)?.cause).toBe(outageCause);
    const bug = await app.request("/photos", {
        headers: { Authorization: "Bearer bug" },
    });
    expect(bug.status).toBe(500);
    expect(await bug.json()).toEqual({ error: "Internal server error" });
    expect(bug.headers.get("Cache-Control")).toBe("private, no-store");
    expect(reportedErrors.at(-1)).toBe(providerBug);
});

test.each([
    undefined,
    "Basic abc",
    "Bearer",
    "Bearer abc def",
    "Bearer one, Bearer two",
])("rejects malformed Authorization headers (%#)", async (authorization) => {
    const response = await app.request("/photos", {
        headers: authorization ? { authorization } : {},
    });
    expect(response.status).toBe(401);
});

test("ignores credentials in URLs and cookies", async () => {
    const response = await app.request("/photos?access_token=reader", {
        headers: { Cookie: "token=reader" },
    });
    expect(response.status).toBe(401);
});
