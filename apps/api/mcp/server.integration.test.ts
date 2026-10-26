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
import { NoAuthenticationProvider } from "../auth/no-auth";
import { requestApp } from "../auth/test-fixtures";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
    Client,
    StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { ImageUploadApi } from "../api/image-uploads";
import sharp from "sharp";
import { ImageConfiguration } from "../services/image-config";
import { z } from "zod";
import { DatabaseSchema as schema } from "../db/schema";
import { Scope } from "../api/scope";
import { ApiValidation } from "../api/validation";
import { PhotoApi } from "../api/photos";
import { readyUpload } from "../api/test-fixtures";
import { AuthenticationError } from "../auth/provider";
import type { AuthIdentity } from "../auth/provider";
import { testAuthIdentity, testAuthSettings } from "../auth/test-fixtures";
import type { BlobStorage } from "../services/blob-storage";
import { ImageStorage } from "../services/image-storage";
import { photoUpdateResponse } from "../http/response";
import { HttpApplication } from "../http/app";
import { HttpConfiguration } from "../http/config";
import { McpConfiguration } from "./config";

const database = new PGlite();
const db = drizzle(database, { schema: schema.definition });
const config = new McpConfiguration(
    new URL("https://cms.example.com"),
    testAuthSettings,
    { allowedOrigins: ["https://editor.example.com"] },
);
const objects = new Map<string, Blob>();
let signedDownloads = false;
let readError: Error | undefined;
const blobs: BlobStorage = {
    createUpload: async (key, type) => ({
        url: `https://bucket.example.com/${key}`,
        method: "PUT",
        headers: { "Content-Type": type },
    }),
    get: async (key) => objects.get(key),
    read: async (key, expiresIn) => {
        if (readError) throw readError;
        return signedDownloads
            ? {
                  url: `https://bucket.example.com/${key}?signed`,
                  expiresAt: new Date(Date.now() + expiresIn * 1000),
              }
            : objects.has(key)
              ? { file: objects.get(key)! }
              : undefined;
    },
    write: async (key, bytes, type) => {
        objects.set(key, new Blob([bytes], { type }));
    },
    delete: async (key) => {
        objects.delete(key);
    },
};
const identities: Record<string, AuthIdentity> = {
    admin: testAuthIdentity,
    reader: { ...testAuthIdentity, scopes: new Set([Scope.PhotosRead]) },
    hiddenReader: {
        ...testAuthIdentity,
        scopes: new Set([Scope.PhotosReadHidden]),
    },
    text: { ...testAuthIdentity, scopes: new Set([Scope.PhotosTextUpdate]) },
    metadata: {
        ...testAuthIdentity,
        scopes: new Set([Scope.PhotosMetadataUpdate]),
    },
    creator: { ...testAuthIdentity, scopes: new Set([Scope.PhotosCreate]) },
    assets: { ...testAuthIdentity, scopes: new Set([Scope.PhotosAssetsWrite]) },
    other: { ...testAuthIdentity, subject: "other-user" },
    otherIssuer: { ...testAuthIdentity, issuer: "https://another.example.com" },
    outsider: { ...testAuthIdentity, subject: "outsider" },
    none: { ...testAuthIdentity, scopes: new Set() },
};
const errors: Error[] = [];
const app = new HttpApplication(
    {
        db,
        mcp: config,
        imageConfig: new ImageConfiguration({ maxBytes: 30_000 }),
        getImageStorage: () => new ImageStorage(blobs),
        reportError: (error) => errors.push(error),
        authentication: {
            scheme: "bearer",
            authenticate: async (token) => {
                const identity = token ? identities[token] : undefined;
                if (!identity) throw new AuthenticationError();
                return identity;
            },
        },
        allowedSubjects: [testAuthIdentity.subject, "other-user"],
    },
    new HttpConfiguration({ maxBodyBytes: 65_536 }),
);
const metadata = {
    takenAt: "2026-10-02T12:00:00Z",
    postedAt: "2026-10-02T12:00:00Z",
    altText: "Photo",
    caption: "",
    visible: true,
};
const clients: Client[] = [];

beforeAll(
    () =>
        migrate(db, {
            migrationsFolder: fileURLToPath(
                new URL("../../../migrations/", import.meta.url),
            ),
        }),
    30_000,
);
afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await database.close();
});

async function connect(
    token: string,
    mode: "legacy" | "auto" = "legacy",
    responses: { status: number; headers: Pick<Headers, "get"> }[] = [],
) {
    const client = new Client(
        { name: "cms-integration", version: "1.0.0" },
        { versionNegotiation: { mode } },
    );
    clients.push(client);
    await client.connect(
        new StreamableHTTPClientTransport(config.url, {
            authProvider: { token: async () => token },
            fetch: async (input, init) => {
                const response = await requestApp(app, input.toString(), init);
                responses.push(response);
                return response;
            },
        }),
    );
    return client;
}
function output(result: CallToolResult) {
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toBeDefined();
    return z.record(z.string(), z.unknown()).parse(result.structuredContent);
}
async function photo(visible = true, postedAt = metadata.postedAt) {
    return PhotoApi.create(db, {
        ...metadata,
        takenAt: new Date(metadata.takenAt),
        postedAt: new Date(postedAt),
        visible,
        assets: [{ assetLocation: "photo.webp", width: 640, height: 320 }],
    });
}
function request(
    token?: string,
    headers: Record<string, string> = {},
    body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
) {
    return requestApp(app, config.url.href, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...headers,
        },
        body,
    });
}

test.each(["legacy", "auto"] as const)(
    "official MCP client discovers schemas and reads photos (%s)",
    async (mode) => {
        const saved = await photo();
        const client = await connect("reader", mode);
        expect(client.getNegotiatedProtocolVersion()).toBe(
            mode === "auto" ? "2026-07-28" : "2025-11-25",
        );
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(15);
        expect(
            tools.find((tool) => tool.name === "list_photos")?.annotations
                ?.readOnlyHint,
        ).toBe(true);
        expect(
            tools.find((tool) => tool.name === "update_photo")?.annotations
                ?.destructiveHint,
        ).toBe(true);
        expect(
            tools.find((tool) => tool.name === "create_photo")?.inputSchema
                .properties,
        ).toHaveProperty("uploadId");
        const result = output(
            await client.callTool({
                name: "get_photo",
                arguments: { id: saved.id },
            }),
        );
        expect(result).toMatchObject({
            id: saved.id,
            altText: "Photo",
            assets: [{ filename: "photo.webp" }],
        });
        const page = output(
            await client.callTool({
                name: "list_photos",
                arguments: { limit: 1 },
            }),
        );
        expect(page).toMatchObject({ limit: 1, offset: 0 });
        expect(page["items"]).toHaveLength(1);
    },
);

test.each(["legacy", "auto"] as const)(
    "hidden photos require additive read privilege for lists, metadata, and images (%s)",
    async (mode) => {
        const year = mode === "legacy" ? 2098 : 2099;
        const hidden = await photo(false, `${year}-10-03T12:00:00Z`);
        const first = await photo(true, `${year}-10-02T12:00:00Z`);
        const second = await photo(true, `${year}-10-01T12:00:00Z`);
        const image = new Blob(["hidden-image"], { type: "image/webp" });
        objects.set(`images/${hidden.id}/photo.webp`, image);
        const reader = await connect("reader", mode);
        const admin = await connect("admin", mode);

        for (const [offset, expected] of [
            [0, first.id],
            [1, second.id],
        ] as const) {
            const page = output(
                await reader.callTool({
                    name: "list_photos",
                    arguments: { limit: 1, offset },
                }),
            );
            expect(page).toMatchObject({ limit: 1, offset });
            expect(page["items"]).toEqual([
                expect.objectContaining({ id: expected, visible: true }),
            ]);
        }
        const adminPage = output(
            await admin.callTool({
                name: "list_photos",
                arguments: { limit: 3 },
            }),
        );
        expect(adminPage["items"]).toEqual([
            expect.objectContaining({ id: hidden.id, visible: false }),
            expect.objectContaining({ id: first.id }),
            expect.objectContaining({ id: second.id }),
        ]);

        for (const name of ["get_photo", "get_photo_image"]) {
            const denied = await reader.callTool({
                name,
                arguments: { id: hidden.id },
            });
            expect(denied).toMatchObject({
                isError: true,
                content: [{ type: "text", text: "Photo not found" }],
            });
        }
        expect(
            output(
                await admin.callTool({
                    name: "get_photo",
                    arguments: { id: hidden.id },
                }),
            ),
        ).toMatchObject({ id: hidden.id, visible: false });
        const downloaded = await admin.callTool({
            name: "get_photo_image",
            arguments: { id: hidden.id },
        });
        expect(downloaded.isError).not.toBe(true);
        expect(downloaded.content).toEqual([
            {
                type: "image",
                mimeType: "image/webp",
                data: Buffer.from(await image.arrayBuffer()).toString("base64"),
            },
        ]);

        const hiddenReader = await connect("hiddenReader", mode);
        for (const [name, args] of [
            ["list_photos", {}],
            ["get_photo", { id: hidden.id }],
            ["get_photo_image", { id: hidden.id }],
        ] as const) {
            await expect(
                hiddenReader.callTool({ name, arguments: args }),
            ).rejects.toThrow();
        }
    },
);

test("authentication errors advertise public OAuth discovery without exposing tools", async () => {
    for (const token of [undefined, "invalid"]) {
        const response = await request(token);
        expect(response.status).toBe(401);
        expect(response.headers.get("WWW-Authenticate")).toContain(
            `resource_metadata="${config.authorization!.metadataUrl}"`,
        );
        if (token === undefined) {
            expect(response.headers.get("WWW-Authenticate")).toBe(
                `Bearer resource_metadata="${config.authorization!.metadataUrl}"`,
            );
        }
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect((await request("outsider")).status).toBe(403);
    const response = await requestApp(app, config.authorization!.metadataUrl);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
        resource: "https://cms.example.com/",
        authorization_servers: [testAuthSettings.issuer],
        bearer_methods_supported: ["header"],
        scopes_supported: expect.arrayContaining([
            Scope.PhotosRead,
            Scope.PhotosReadHidden,
        ]),
    });
});

test("an allowed browser origin can send the modern SDK's actual headers", async () => {
    const origin = "https://editor.example.com";
    const client = new Client(
        { name: "browser-integration", version: "1.0.0" },
        { versionNegotiation: { mode: "auto" } },
    );
    clients.push(client);
    const sent = new Set<string>();
    await client.connect(
        new StreamableHTTPClientTransport(config.url, {
            authProvider: { token: async () => "reader" },
            fetch: async (input, init) => {
                const headers = new Headers(init?.headers);
                const requested = [...headers.keys()];
                const preflight = await requestApp(app, input.toString(), {
                    method: "OPTIONS",
                    headers: {
                        Origin: origin,
                        "Access-Control-Request-Method": init?.method ?? "GET",
                        "Access-Control-Request-Headers": requested.join(","),
                    },
                });
                expect(preflight.status).toBe(204);
                expect(
                    preflight.headers.get("Access-Control-Allow-Origin"),
                ).toBe(origin);
                const allowed = preflight.headers
                    .get("Access-Control-Allow-Headers")!
                    .toLowerCase()
                    .split(",")
                    .map((header) => header.trim());
                for (const header of requested) {
                    sent.add(header);
                    if (header !== "accept") expect(allowed).toContain(header);
                }
                headers.set("Origin", origin);
                const response = await requestApp(app, input.toString(), {
                    ...init,
                    headers,
                });
                expect(
                    response.headers.get("Access-Control-Allow-Origin"),
                ).toBe(origin);
                return response;
            },
        }),
    );
    await client.callTool({ name: "list_photos", arguments: {} });
    expect(sent.has("mcp-method")).toBe(true);
    expect(sent.has("mcp-name")).toBe(true);
});

test("MCP validates hosts, browser origins, preflight, and body limits", async () => {
    expect((await request("admin", { Host: "evil.example" })).status).toBe(403);
    expect(
        (await request("admin", { Origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await request("admin", { Origin: "null" })).status).toBe(403);
    const wrongHost = await requestApp(app, "https://evil.example/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer admin" },
    });
    expect(wrongHost.status).toBe(403);
    const preflight = await requestApp(app, config.url.href, {
        method: "OPTIONS",
        headers: {
            Origin: "https://editor.example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers":
                "authorization,content-type,mcp-protocol-version,mcp-method,mcp-name",
        },
    });
    expect(preflight.status).toBe(204);
    const allowed = preflight.headers
        .get("Access-Control-Allow-Headers")!
        .toLowerCase()
        .split(",")
        .map((header) => header.trim());
    for (const header of [
        "authorization",
        "content-type",
        "mcp-protocol-version",
        "mcp-method",
        "mcp-name",
    ])
        expect(allowed).toContain(header);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://editor.example.com",
    );
    expect(
        (
            await request(
                "admin",
                {},
                JSON.stringify({ padding: "x".repeat(110_000) }),
            )
        ).status,
    ).toBe(413);
    expect((await request("admin", {}, "{")).status).toBe(400);
});

test.each(["legacy", "auto"] as const)(
    "scope challenges request the precise permissions before writes (%s)",
    async (mode) => {
        const saved = await photo();
        for (const [token, name, args, scopes] of [
            [
                "reader",
                "start_photo_upload",
                { contentType: "image/png" },
                [Scope.PhotosCreate],
            ],
            ["reader", "get_camera", { id: saved.id }, [Scope.CamerasRead]],
            ["reader", "get_lens", { id: saved.id }, [Scope.LensesRead]],
            [
                "reader",
                "update_photo",
                { id: saved.id, changes: { altText: "Denied" } },
                [Scope.PhotosTextUpdate],
            ],
            [
                "text",
                "update_photo",
                { id: saved.id, changes: { visible: false } },
                [Scope.PhotosMetadataUpdate],
            ],
            [
                "text",
                "update_photo",
                {
                    id: saved.id,
                    changes: { altText: "Denied", visible: false },
                },
                [Scope.PhotosTextUpdate, Scope.PhotosMetadataUpdate],
            ],
            [
                "metadata",
                "update_photo",
                { id: saved.id, changes: { altText: "Denied" } },
                [Scope.PhotosTextUpdate],
            ],
            [
                "metadata",
                "update_photo",
                { id: saved.id, changes: { description: "Denied" } },
                [Scope.PhotosTextUpdate],
            ],
        ] as const) {
            const responses: {
                status: number;
                headers: Pick<Headers, "get">;
            }[] = [];
            const client = await connect(token, mode, responses);
            await expect(
                client.callTool({ name, arguments: args }),
            ).rejects.toThrow();
            const response = responses.at(-1)!;
            expect(response.status).toBe(403);
            const challenge = response.headers.get("WWW-Authenticate")!;
            expect(challenge).toContain('error="insufficient_scope"');
            expect(challenge).toContain(`scope="${scopes.join(" ")}"`);
            expect(challenge).toContain(
                `resource_metadata="${config.authorization!.metadataUrl}"`,
            );
        }
        expect(await PhotoApi.read(db, saved.id)).toMatchObject({
            altText: "Photo",
            visible: true,
        });
        const text = await connect("text", mode);
        const textResult = output(
            await text.callTool({
                name: "update_photo",
                arguments: {
                    id: saved.id,
                    changes: {
                        altText: "Accessible text",
                        description: "A **Markdown** description",
                    },
                },
            }),
        );
        expect(textResult).toEqual({ id: saved.id });
        const metadata = await connect("metadata", mode);
        const metadataResult = output(
            await metadata.callTool({
                name: "update_photo",
                arguments: { id: saved.id, changes: { visible: false } },
            }),
        );
        expect(metadataResult).toEqual({ id: saved.id });
        expect(await PhotoApi.read(db, saved.id)).toMatchObject({
            altText: "Accessible text",
            description: "A **Markdown** description",
            visible: false,
        });
    },
);

test("create-only users can consume their upload and add equipment, but cannot reuse another identity's upload", async () => {
    const client = await connect("creator");
    const uploadId = await readyUpload(db);
    const created = output(
        await client.callTool({
            name: "create_photo",
            arguments: {
                ...metadata,
                uploadId,
                camera: { create: { name: "New camera" } },
            },
        }),
    );
    expect(created).toEqual({ id: expect.any(String) });
    const saved = await PhotoApi.read(
        db,
        ApiValidation.uuid.parse(created["id"]),
    );
    expect(saved.camera?.name).toBe("New camera");
    await expect(
        client.callTool({ name: "get_photo", arguments: { id: saved.id } }),
    ).rejects.toThrow();
    for (const token of ["other", "otherIssuer"]) {
        const other = await connect(token);
        expect(
            (
                await other.callTool({
                    name: "create_photo",
                    arguments: { ...metadata, uploadId },
                })
            ).isError,
        ).toBe(true);
    }
});

test("upload tools preserve ownership through processing, preview, and creation", async () => {
    const creator = await connect("creator");
    const other = await connect("other");
    const receipt = output(
        await creator.callTool({
            name: "start_photo_upload",
            arguments: { contentType: "image/png" },
        }),
    );
    const uploadId = receipt["id"] as string;
    expect(receipt).not.toHaveProperty("upload");
    const bytes = await sharp({
        create: { width: 32, height: 16, channels: 3, background: "red" },
    })
        .png()
        .toBuffer();
    const uploaded = await creator.callTool({
        name: "upload_photo_image",
        arguments: {
            uploadId,
            contentType: "image/png",
            dataBase64: bytes.toString("base64"),
        },
    });
    expect(uploaded.isError).not.toBe(true);
    expect(
        (
            await other.callTool({
                name: "upload_photo_image",
                arguments: {
                    uploadId,
                    contentType: "image/png",
                    dataBase64: bytes.toString("base64"),
                },
            })
        ).isError,
    ).toBe(true);
    for (const name of [
        "get_photo_upload",
        "complete_photo_upload",
        "cancel_photo_upload",
    ]) {
        expect(
            (await other.callTool({ name, arguments: { uploadId } })).isError,
        ).toBe(true);
    }
    const ready = output(
        await creator.callTool({
            name: "complete_photo_upload",
            arguments: { uploadId },
        }),
    );
    expect(ready["status"]).toBe("ready");
    const filename = (ready["assets"] as { filename: string }[])[0]!.filename;
    const preview = await creator.callTool({
        name: "get_upload_preview",
        arguments: { uploadId, filename },
    });
    expect(preview.isError).not.toBe(true);
    expect(preview.content[0]).toMatchObject({
        type: "image",
        mimeType: "image/webp",
        data: expect.any(String),
    });
    output(
        await creator.callTool({
            name: "create_photo",
            arguments: { ...metadata, uploadId },
        }),
    );
    expect(
        (
            await creator.callTool({
                name: "get_upload_preview",
                arguments: { uploadId, filename },
            })
        ).isError,
    ).toBe(true);
});

test("image tools issue 15-minute downloads only for assets belonging to the photo", async () => {
    const saved = await photo();
    const reader = await connect("reader");
    signedDownloads = true;
    try {
        const started = Date.now();
        const result = output(
            await reader.callTool({
                name: "get_photo_image",
                arguments: { id: saved.id },
            }),
        );
        expect(result["url"]).toContain(`/images/${saved.id}/photo.webp`);
        expect(
            new Date(result["expiresAt"] as string).getTime() - started,
        ).toBeWithin(899_000, 901_000);
        expect(
            (
                await reader.callTool({
                    name: "get_photo_image",
                    arguments: { id: saved.id, filename: "../another.webp" },
                })
            ).isError,
        ).toBe(true);
    } finally {
        signedDownloads = false;
    }
});

test.each(["legacy", "auto"] as const)(
    "MCP blocks deletion and replacement even with an admin token (%s)",
    async (mode) => {
        const responses: { status: number; headers: Pick<Headers, "get"> }[] =
            [];
        const admin = await connect("admin", mode, responses);
        const saved = await photo();
        const { tools } = await admin.listTools();
        for (const name of [
            "delete_photo",
            "delete_camera",
            "delete_lens",
            "start_photo_replacement",
        ]) {
            expect(tools.map((tool) => tool.name)).not.toContain(name);
            await expect(
                admin.callTool({
                    name,
                    arguments: {
                        id: saved.id,
                        photoId: saved.id,
                        contentType: "image/png",
                    },
                }),
            ).rejects.toThrow("not found");
        }
        const replacement = await ImageUploadApi.replace(
            db,
            new ImageStorage(blobs),
            saved.id,
            "image/png",
            testAuthIdentity,
        );
        for (const name of [
            "get_photo_upload",
            "complete_photo_upload",
            "cancel_photo_upload",
        ]) {
            for (const args of [
                { uploadId: replacement.id },
                { uploadId: replacement.id, photoId: saved.id },
            ]) {
                const result = await admin.callTool({ name, arguments: args });
                expect(result.isError).toBe(true);
                const response = responses.at(-1)!;
                expect(response.status).toBe(200);
                expect(response.headers.get("WWW-Authenticate")).toBeNull();
            }
        }
        expect(
            (
                await ImageUploadApi.read(
                    db,
                    replacement.id,
                    testAuthIdentity,
                    saved.id,
                )
            ).status,
        ).toBe("pending");
        expect((await PhotoApi.read(db, saved.id)).assets).toMatchObject([
            { assetLocation: "photo.webp" },
        ]);
        const discovery = await requestApp(
            app,
            config.authorization!.metadataUrl,
        );
        const body = (await discovery.json()) as { scopes_supported: string[] };
        expect(body.scopes_supported).not.toContain(Scope.PhotosDelete);
        expect(body.scopes_supported).not.toContain(Scope.PhotosAssetsWrite);
        expect(body.scopes_supported).not.toContain(Scope.CamerasDelete);
        expect(body.scopes_supported).not.toContain(Scope.LensesDelete);
    },
);

test("invalid tool inputs cannot smuggle assets or metadata writes", async () => {
    const client = await connect("admin");
    const saved = await photo();
    for (const call of [
        { name: "get_photo", arguments: { id: "invalid" } },
        { name: "list_photos", arguments: { limit: 101 } },
        { name: "update_photo", arguments: { id: saved.id, changes: {} } },
        {
            name: "update_photo",
            arguments: { id: saved.id, changes: { assets: [] } },
        },
        { name: "start_photo_upload", arguments: { contentType: "text/html" } },
        {
            name: "create_photo",
            arguments: {
                ...metadata,
                uploadId: await readyUpload(db),
                assets: [],
            },
        },
    ]) {
        expect((await client.callTool(call)).isError).toBe(true);
    }
    expect(await PhotoApi.read(db, saved.id)).toMatchObject({
        assets: [{ assetLocation: "photo.webp" }],
    });
});

test("storage failures are reported internally without leaking details to MCP", async () => {
    const saved = await photo();
    const reader = await connect("reader");
    const failure = new Error("private-storage-secret");
    readError = failure;
    try {
        const result = await reader.callTool({
            name: "get_photo_image",
            arguments: { id: saved.id },
        });
        expect(result).toMatchObject({
            isError: true,
            content: [{ type: "text", text: "Internal server error" }],
        });
        expect(JSON.stringify(result)).not.toContain(failure.message);
        expect(errors).toContain(failure);
    } finally {
        readError = undefined;
    }
});

test("no-auth MCP works without bearer tokens and retains origin checks and the tool ceiling", async () => {
    const noAuth = new NoAuthenticationProvider();
    const mcp = new McpConfiguration(config.url, { kind: "no-auth" });
    const open = new HttpApplication({
        db,
        mcp,
        authentication: noAuth,
        allowedSubjects: [NoAuthenticationProvider.subject],
        getImageStorage: () => new ImageStorage(blobs),
        reportError: (error) => errors.push(error),
    });
    const client = new Client({ name: "no-auth-test", version: "1.0.0" });
    try {
        await client.connect(
            new StreamableHTTPClientTransport(mcp.url, {
                fetch: (input, init) =>
                    Promise.resolve(requestApp(open, input.toString(), init)),
            }),
        );
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("list_photos");
        for (const name of [
            "delete_photo",
            "delete_camera",
            "delete_lens",
            "start_photo_replacement",
        ]) {
            expect(tools.tools.map((tool) => tool.name)).not.toContain(name);
            await expect(
                client.callTool({
                    name,
                    arguments: { id: crypto.randomUUID() },
                }),
            ).rejects.toThrow("not found");
        }
        const result = await client.callTool({
            name: "list_photos",
            arguments: {},
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toHaveProperty("items");
        for (const path of [
            "/.well-known/oauth-protected-resource",
            "/.well-known/oauth-protected-resource/mcp",
        ]) {
            expect(
                (await requestApp(open, new URL(path, config.url).href)).status,
            ).toBe(404);
        }
        const rejected = await requestApp(open, mcp.url.href, {
            method: "POST",
            headers: { Origin: "https://other.example.com" },
        });
        expect(rejected.status).toBe(403);
        expect(rejected.headers.get("WWW-Authenticate")).toBeNull();
    } finally {
        await client.close();
    }
});

test.each(["text", "metadata"])(
    "HTTP photo updates do not disclose hidden metadata to %s writers",
    async (token) => {
        const saved = await photo(false);
        const changes =
            token === "text" ? { caption: "Edited" } : { location: "Edited" };
        const response = await requestApp(app, `/api/photos/${saved.id}`, {
            method: "PATCH",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(changes),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: saved.id });
        expect(await PhotoApi.read(db, saved.id)).toMatchObject(changes);
    },
);

test.each([
    [false, [], false],
    [false, [Scope.PhotosRead], false],
    [false, [Scope.PhotosReadHidden], false],
    [false, [Scope.PhotosRead, Scope.PhotosReadHidden], true],
    [true, [], false],
    [true, [Scope.PhotosRead], true],
] as const)(
    "photo update disclosure: visible=%s scopes=%j readable=%s",
    async (visible, scopes, readable) => {
        const saved = await photo(visible);
        const result = photoUpdateResponse(saved, {
            ...testAuthIdentity,
            scopes: new Set<Scope>(scopes),
        });
        if (readable) expect(result).toHaveProperty("assets");
        else expect(result).toEqual({ id: saved.id });
    },
);
