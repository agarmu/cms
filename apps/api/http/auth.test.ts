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
import { Elysia } from "elysia";
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
import { HttpAuthentication } from "./auth";
import { HttpErrorHandler } from "./errors";
import { HttpAccess } from "./scope";

const db = drizzle.mock({ schema: DatabaseSchema.definition });
const reportedErrors: Error[] = [];
const providerBug = new TypeError("provider bug");
const outageCause = new Error("connection refused");
const authentication: AuthenticationProvider = {
    scheme: "bearer",
    async authenticate(token) {
        if (token === "reader")
            return { ...testAuthIdentity, scopes: new Set([Scope.PhotosRead]) };
        if (token === "writer")
            return {
                ...testAuthIdentity,
                scopes: new Set([Scope.PhotosCreate]),
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
    takenAt: "2026-10-02T12:00:00Z",
    postedAt: "2026-10-02T12:00:00Z",
    altText: "photo",
    caption: "",
    visible: true,
};
const routes: [string, string, unknown?][] = [
    ["GET", "/api/photos"],
    ["GET", `/api/photos/${photoId}`],
    ["GET", `/api/photos/${photoId}/image`],
    ["GET", `/api/photos/${photoId}/assets/original.webp`],
    ["POST", "/api/photos", metadata],
    ["PATCH", `/api/photos/${photoId}`, { altText: "changed" }],
    ["DELETE", `/api/photos/${photoId}`],
    ["PATCH", `/api/cameras/${photoId}`, { name: "Renamed" }],
    ["PATCH", `/api/lenses/${photoId}`, { name: "Renamed" }],
    ["POST", "/api/photo-uploads", { contentType: "image/png" }],
    ["GET", `/api/photo-uploads/${uploadId}`],
    ["GET", `/api/photo-uploads/${uploadId}/assets/original.webp`],
    ["POST", `/api/photo-uploads/${uploadId}/complete`],
    ["POST", `/api/photo-uploads/${uploadId}/cancel`],
    ["POST", `/api/photos/${photoId}/uploads`, { contentType: "image/png" }],
    ["GET", `/api/photos/${photoId}/uploads/${uploadId}`],
    ["POST", `/api/photos/${photoId}/uploads/${uploadId}/complete`],
    ["POST", `/api/photos/${photoId}/uploads/${uploadId}/cancel`],
    ...["cameras", "lenses"].flatMap((resource): [string, string][] => [
        ["GET", `/api/${resource}`],
        ["GET", `/api/${resource}/${photoId}`],
        ["DELETE", `/api/${resource}/${photoId}`],
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
        const response = await requestApp(app, path, init);
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
        const response = await requestApp(app, path, init);
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
        const response = await requestApp(app, "/api/photos", {
            headers: { authorization },
        });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(body);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    },
);

test("authenticates before parsing a request body", async () => {
    const response = await requestApp(app, "/api/photos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
    });
    expect(response.status).toBe(401);
});

test("checks exact scopes and passes AuthIdentity to permitted handlers", async () => {
    const auth = new HttpAuthentication(authentication, [
        testAuthIdentity.subject,
    ]);
    const access = new HttpAccess(db, auth);
    let writes = 0;
    const scoped = new Elysia()
        .use(
            new HttpErrorHandler((error) => {
                throw error;
            }).plugin,
        )
        .use(auth.plugin)
        .use(access.plugin)
        .get("/", ({ authIdentity }) => ({ subject: authIdentity.subject }), {
            read: Scope.PhotosRead,
        })
        .post(
            "/",
            () => {
                writes++;
                return { saved: true };
            },
            { write: Scope.PhotosCreate },
        );
    const read = await requestApp(scoped, "/", {
        headers: { Authorization: "Bearer reader" },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ subject: "test-user" });
    expect(
        (
            await requestApp(scoped, "/", {
                method: "POST",
                headers: { Authorization: "Bearer reader" },
            })
        ).status,
    ).toBe(403);
    expect(writes).toBe(0);
    expect(
        (
            await requestApp(scoped, "/", {
                method: "POST",
                headers: { Authorization: "Bearer writer" },
            })
        ).status,
    ).toBe(200);
    expect(writes).toBe(1);
    expect(
        (
            await requestApp(scoped, "/", {
                headers: { Authorization: "Bearer writer" },
            })
        ).status,
    ).toBe(403);
});

test("without a subject allowlist, verified users still need each operation's scope", async () => {
    const auth = new HttpAuthentication(authentication);
    const scoped = new Elysia()
        .use(
            new HttpErrorHandler((error) => {
                throw error;
            }).plugin,
        )
        .use(auth.plugin)
        .use(new HttpAccess(db, auth).plugin)
        .get("/", ({ authIdentity }) => ({ subject: authIdentity.subject }), {
            read: Scope.PhotosRead,
        });
    const permitted = await requestApp(scoped, "/", {
        headers: { Authorization: "Bearer stranger" },
    });
    expect(permitted.status).toBe(200);
    expect(await permitted.json()).toEqual({ subject: "stranger" });
    for (const [token, status] of [
        ["writer", 403],
        ["invalid", 401],
        [undefined, 401],
    ] as const) {
        const response = await requestApp(scoped, "/", {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        expect(response.status).toBe(status);
    }
});

test("scope checks fail closed if authentication middleware is missing", async () => {
    const auth = new HttpAuthentication(authentication, [
        testAuthIdentity.subject,
    ]);
    const scoped = new Elysia()
        .use(
            new HttpErrorHandler((error) => {
                throw error;
            }).plugin,
        )
        .use(new HttpAccess(db, auth).plugin)
        .get(
            "/",
            () => {
                throw new Error("Must not run");
            },
            { read: Scope.PhotosRead },
        );
    expect((await requestApp(scoped, "/")).status).toBe(401);
});

test("authenticated responses cannot opt into public caching", async () => {
    const scoped = new Elysia()
        .use(
            new HttpAuthentication(authentication, [testAuthIdentity.subject])
                .plugin,
        )
        .get(
            "/",
            () =>
                new Response("image", {
                    headers: { "Cache-Control": "public, max-age=31536000" },
                }),
        );
    const response = await requestApp(scoped, "/", {
        headers: { Authorization: "Bearer reader" },
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});

test.each(routes.filter(([method]) => method !== "GET"))(
    "checks scopes before parsing malformed bodies on %s %s",
    async (method, path) => {
        const response = await requestApp(app, path, {
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
    const outage = await requestApp(app, "/api/photos", {
        headers: { Authorization: "Bearer outage" },
    });
    expect(outage.status).toBe(503);
    expect(reportedErrors.at(-1)?.cause).toBe(outageCause);
    const bug = await requestApp(app, "/api/photos", {
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
    const response = await requestApp(app, "/api/photos", {
        headers: authorization ? { authorization } : {},
    });
    expect(response.status).toBe(401);
});

test("ignores credentials in URLs and cookies", async () => {
    const response = await requestApp(app, "/api/photos?access_token=reader", {
        headers: { Cookie: "token=reader" },
    });
    expect(response.status).toBe(401);
});

test("oversized streaming bodies are rejected and cancelled without a content length", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            controller.enqueue(new Uint8Array(32_768));
        },
        cancel() {
            cancelled = true;
        },
    });
    const response = await requestApp(app, "/api/photos", {
        method: "POST",
        headers: {
            Authorization: "Bearer writer",
            "Content-Type": "application/json",
        },
        body,
    });
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
});
