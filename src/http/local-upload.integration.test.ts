import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
    Client,
    StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import sharp from "sharp";
import { Application } from "../application";
import { DatabaseSchema as schema } from "../db/schema";
import { LocalUploadStorage } from "../services/local-upload-storage";
import { ImageConfiguration } from "../services/image-config";
import { McpConfiguration } from "../mcp/config";
import { testAuthIdentity } from "../auth/test-fixtures";
import { AuthenticationError } from "../auth/provider";

// A real bearer-protected API: the token PUT must also work without a bearer token.
test("MCP local upload creates a photo; token PUTs reject tampering, cancellation, and replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-upload-"));
    const database = new PGlite();
    const db = drizzle(database, { schema: schema.definition });
    const baseUrl = new URL("http://localhost:3000");
    const blobs = new LocalUploadStorage(directory, baseUrl, 300_000);
    const errors: Error[] = [];
    const app = new Application({
        db,
        getBlobStorage: () => blobs,
        imageConfig: new ImageConfiguration({ maxBytes: 300_000 }),
        authentication: {
            scheme: "bearer",
            authenticate: async (token) => {
                if (token !== "test") throw new AuthenticationError();
                return testAuthIdentity;
            },
        },
        allowedSubjects: [testAuthIdentity.subject],
        reportError: (error) => errors.push(error),
        mcpConfig: new McpConfiguration(baseUrl, { kind: "no-auth" }),
    });
    const client = new Client({ name: "local-upload-test", version: "1.0.0" });
    const send = (url: string, init: RequestInit = {}) =>
        app.http.fetch(new Request(url, init));
    try {
        await migrate(db, {
            migrationsFolder: fileURLToPath(
                new URL("../../migrations/", import.meta.url),
            ),
        });
        await client.connect(
            new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
                requestInit: { headers: { Authorization: "Bearer test" } },
                fetch: (input, init) => send(input.toString(), init),
            }),
        );
        const start = async () => {
            const result = await client.callTool({
                name: "start_photo_upload",
                arguments: { contentType: "image/png" },
            });
            expect(result.isError).not.toBe(true);
            return result.structuredContent as {
                id: string;
                upload: { url: string; headers: Record<string, string> };
            };
        };
        const upload = await start();
        const png = await sharp(randomBytes(256 * 256 * 3), {
            raw: { width: 256, height: 256, channels: 3 },
        })
            .png()
            .toBuffer();
        expect(png.length).toBeGreaterThan(65_536);
        const put = (
            url = upload.upload.url,
            body: Uint8Array = png,
            headers = upload.upload.headers,
        ) => send(url, { method: "PUT", headers, body });
        expect((await put(upload.upload.url + "x")).status).toBe(403);
        expect(
            (
                await put(upload.upload.url, png, {
                    "Content-Type": "image/jpeg",
                })
            ).status,
        ).toBe(400);
        expect(
            (await put(upload.upload.url, new Uint8Array(300_001))).status,
        ).toBe(413);
        expect((await put()).status).toBe(204);
        expect((await put()).status).toBe(403);
        const finished = await client.callTool({
            name: "complete_photo_upload",
            arguments: { uploadId: upload.id },
        });
        expect(finished.isError).not.toBe(true);
        expect(finished.structuredContent).toHaveProperty("status", "ready");
        const created = await client.callTool({
            name: "create_photo",
            arguments: {
                uploadId: upload.id,
                taken: "2026-10-11T12:00:00.000Z",
                posted: "2026-10-11T12:00:00.000Z",
                alt: "Local upload",
                description: "Test",
                enabled: true,
            },
        });
        expect(created.isError).not.toBe(true);
        const id = (created.structuredContent as { id: string }).id;
        const image = await send(
            new URL(`/api/photos/${id}/image`, baseUrl).href,
            { headers: { Authorization: "Bearer test" } },
        );
        expect(image.status).toBe(200);
        expect(image.headers.get("Content-Type")).toContain("image/webp");
        expect((await put()).status).toBe(403);
        const cancelled = await start();
        await client.callTool({
            name: "cancel_photo_upload",
            arguments: { uploadId: cancelled.id },
        });
        expect((await put(cancelled.upload.url)).status).toBe(409);
        expect(errors).toEqual([]);
    } finally {
        await client.close();
        await app.stop();
        await database.close();
        await rm(directory, { recursive: true, force: true });
    }
}, 30_000);
