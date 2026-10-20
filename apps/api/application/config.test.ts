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
import { testAuthSettings, testAuthToml } from "../auth/test-fixtures";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationConfig } from "./config";
import { StorageFactory } from "./storage";

const minimal =
    testAuthToml +
    '[database]\nurl = "postgres://user@localhost/cms"\n[storage]\nbackend = "local"\ndirectory = "./data/blobs"\n';

test("demo configuration uses separate database credentials and storage", () => {
    const config = new ApplicationConfig(
        {
            auth: { kind: "no-auth" },
            database: { url: "postgres://user@localhost/cms" },
            storage: { backend: "local", directory: "./data/blobs" },
            demo: {
                database: { url: "postgres://demo@localhost/cms_demo" },
                storage: { backend: "local", directory: "./data/demo-blobs" },
            },
        },
        {
            database: { password: "real-password" },
            demo: { database: { password: "demo-password" } },
        },
    );
    expect(config.demo?.database.clientOptions()).toMatchObject({
        url: "postgres://demo@localhost/cms_demo",
        password: "demo-password",
    });
    expect(config.demo?.storage.directory).toBe("./data/demo-blobs");
    expect(config.database.clientOptions()).toMatchObject({
        password: "real-password",
    });
});

test.each([
    "postgresql://other-user@localhost:5432/cms",
    "postgres://localhost/%63ms",
])("demo cannot publish the main database through %s", (url) => {
    expect(
        () =>
            new ApplicationConfig({
                auth: { kind: "no-auth" },
                database: { url: "postgres://user@localhost/cms" },
                storage: { backend: "local", directory: "./data/blobs" },
                demo: {
                    database: { url },
                    storage: {
                        backend: "local",
                        directory: "./data/demo-blobs",
                    },
                },
            }),
    ).toThrow("Invalid configuration");
});

async function withFiles(
    config: string,
    secrets: string,
    run: (configPath: string, secretsPath: string) => Promise<void>,
) {
    const directory = await mkdtemp(join(tmpdir(), "cms-config-"));
    try {
        const configPath = join(directory, "config.toml");
        const secretsPath = join(directory, "secrets.toml");
        await Bun.write(configPath, config);
        await Bun.write(secretsPath, secrets);
        await run(configPath, secretsPath);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test("loads every example table and maps secrets and database units into client options", async () => {
    const config = await ApplicationConfig.fromFiles(
        "docs/config.example.toml",
        "docs/secrets.example.toml",
    );
    expect(config.database.clientOptions()).toMatchObject({
        url: "postgres://example-user@localhost:5432/photos_cms",
        password: "replace-me",
        connectionTimeout: 10,
        idleTimeout: 30,
        max: 10,
        tls: "disable",
    });
    expect(config.workers).toMatchObject({
        interval: 5000,
        batchSize: 10,
        upload: { waitTime: 3600000, retryTime: 10000 },
    });
    expect(
        [0, 1, 2, 3, 4, 5].map((retry) => config.workers.retryDelay(retry)),
    ).toEqual([10000, 20000, 40000, 80000, 160000, undefined]);
    for (const signal of ["traces", "metrics", "logs"] as const) {
        expect(config.telemetry[signal]).toMatchObject({
            enabled: true,
            headers: { Authorization: "Bearer replace-me" },
        });
    }
    expect(config.images.variants).toHaveLength(3);
    expect(config.http.maxBodyBytes).toBe(65536);
    expect(config.auth.kind).toBe("rfc-9068");
});

test("requires authentication configuration", async () => {
    await withFiles(
        minimal.replace(testAuthToml, ""),
        "",
        async (configPath, secretsPath) => {
            await expect(
                ApplicationConfig.fromFiles(configPath, secretsPath),
            ).rejects.toThrow("Invalid configuration");
        },
    );
});

test("signs virtual-hosted storage URLs using file credentials and endpoint region", async () => {
    const config = new ApplicationConfig(
        {
            auth: testAuthSettings,
            serve: { baseUrl: "https://cms.example.com" },
            database: { url: "postgres://localhost/cms" },
            storage: {
                backend: "s3",
                endpoint: "https://photos.s3.eu-west-1.amazonaws.com",
            },
        },
        {
            storage: {
                accessKeyId: "file-key",
                secretAccessKey: "file-secret",
                sessionToken: "file-session",
            },
        },
    );
    const storage = new StorageFactory(config.storage).create();
    const upload = await storage.createUpload!(
        "images/test.png",
        "image/png",
        60,
    );
    const url = new URL(upload.url);
    expect(url.hostname).toBe("photos.s3.eu-west-1.amazonaws.com");
    expect(url.pathname).toBe("/images/test.png");
    expect(url.searchParams.get("X-Amz-Credential")).toContain("file-key/");
    expect(url.searchParams.get("X-Amz-Credential")).toContain(
        "/eu-west-1/s3/",
    );
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("file-session");
});

test("loads file secrets verbatim, applies nested defaults, and rejects environment fallback", async () => {
    await withFiles(
        minimal,
        '[database]\npassword = "p@ss:/?%"\n',
        async (configPath, secretsPath) => {
            const config = await ApplicationConfig.fromFiles(
                configPath,
                secretsPath,
            );
            expect(config.database.clientOptions().password).toBe("p@ss:/?%");
            expect(config.database.pool.maxConnections).toBe(10);
            expect(config.telemetry.traces.enabled).toBe(false);
            await expect(
                ApplicationConfig.fromFiles(
                    configPath + ".missing",
                    secretsPath,
                ),
            ).rejects.toThrow("Cannot read configuration file");
            await expect(
                ApplicationConfig.fromFiles(
                    configPath,
                    secretsPath + ".missing",
                ),
            ).rejects.toThrow("Cannot read configuration file");
        },
    );
});

test.each([
    minimal.replace("user@localhost", "user:private-password@localhost"),
    minimal.replace('/cms"', '/cms?password=private-password"'),
    minimal + "[telemetry.traces]\nenabled = true\n",
    minimal +
        '[telemetry.traces]\nheaders = { Authorization = "private-password" }\n',
    minimal.replace(
        'backend = "local"\ndirectory = "./data/blobs"',
        'backend = "s3"',
    ),
    minimal + "[workers.backoff]\nmultiplier = 1\n",
    minimal + "[database.pool]\nmaxConnections = 0\n",
    minimal + "unknownSetting = true\n",
])(
    "rejects invalid public settings without disclosing values (%#)",
    async (invalid) => {
        await withFiles(invalid, "", async (configPath, secretsPath) => {
            try {
                await ApplicationConfig.fromFiles(configPath, secretsPath);
                throw new Error("Expected rejection");
            } catch (error) {
                expect(String(error)).toContain("Invalid");
                expect(String(error)).not.toContain("private-password");
            }
        });
    },
);

test("rejects invalid secrets and TOML syntax without echoing secret values", async () => {
    for (const secrets of [
        '[database]\npassword = ["private-password"]',
        '[database]\npassword = "private-password',
    ]) {
        await withFiles(minimal, secrets, async (configPath, secretsPath) => {
            try {
                await ApplicationConfig.fromFiles(configPath, secretsPath);
                throw new Error("Expected rejection");
            } catch (error) {
                expect(String(error)).toContain("Invalid");
                expect(String(error)).not.toContain("private-password");
            }
        });
    }
});

test("requires file S3 credentials and rejects public settings in secrets", async () => {
    await withFiles(
        minimal.replace(
            'backend = "local"\ndirectory = "./data/blobs"',
            'backend = "s3"\nendpoint = "https://photos.example.com"',
        ),
        "",
        async (configPath, secretsPath) => {
            await expect(
                ApplicationConfig.fromFiles(configPath, secretsPath),
            ).rejects.toThrow("secrets.toml");
        },
    );
    await withFiles(
        minimal,
        '[database]\nurl = "postgres://localhost/override"',
        async (configPath, secretsPath) => {
            await expect(
                ApplicationConfig.fromFiles(configPath, secretsPath),
            ).rejects.toThrow("Invalid");
        },
    );
});

test.each([
    "not-a-url",
    "http://cms.example.com",
    "https://user:secret@cms.example.com",
    "https://cms.example.com/mcp",
    "https://cms.example.com/?secret=value",
    "https://cms.example.com/#fragment",
])("rejects an invalid application base URL (%s)", (baseUrl) => {
    expect(
        ApplicationConfig.schema.shape.serve
            .unwrap()
            .shape.baseUrl.safeParse(baseUrl).success,
    ).toBe(false);
});

test("example configuration leaves MCP disabled", async () => {
    const config = await ApplicationConfig.fromFiles(
        "docs/config.example.toml",
        "docs/secrets.example.toml",
    );
    expect(config.baseUrl?.href).toBe("https://photos.example.com/");
    expect(config.mcp).toBeUndefined();
    expect(
        new ApplicationConfig({
            auth: testAuthSettings,
            serve: { baseUrl: "https://cms.example.com" },
            database: { url: "postgres://localhost/cms" },
            storage: { backend: "local", directory: "./data" },
        }).mcp,
    ).toBeUndefined();
});

test("accepts the general base URL and rejects mcp.baseUrl", () => {
    const settings = {
        serve: { baseUrl: "https://cms.example.com" },
        auth: testAuthSettings,
        database: { url: "postgres://localhost/cms" },
        storage: { backend: "local" as const, directory: "./data" },
    };
    expect(
        new ApplicationConfig({ ...settings, mcp: { enabled: true } }).mcp?.url
            .href,
    ).toBe("https://cms.example.com/mcp");
    expect(
        ApplicationConfig.schema.safeParse({
            ...settings,
            mcp: { baseUrl: settings.serve.baseUrl },
        }).success,
    ).toBe(false);
});

test("bearer authentication requires the public base URL even without MCP", () => {
    const settings = {
        auth: testAuthSettings,
        database: { url: "postgres://localhost/cms" },
        storage: { backend: "local" as const, directory: "./data" },
    };
    for (const mcp of [undefined, {}, { enabled: false }, { enabled: true }]) {
        expect(
            () =>
                new ApplicationConfig({ ...settings, ...(mcp ? { mcp } : {}) }),
        ).toThrow("Invalid configuration");
        const config = new ApplicationConfig({
            ...settings,
            serve: { baseUrl: "https://cms.example.com" },
            ...(mcp ? { mcp } : {}),
        });
        expect(config.baseUrl?.href).toBe("https://cms.example.com/");
        expect(config.mcp?.authorization?.resource).toBe(
            mcp?.enabled ? "https://cms.example.com/" : undefined,
        );
    }
});

test("supports a fixed token audience while serving local URLs", () => {
    const config = new ApplicationConfig({
        auth: { ...testAuthSettings, audience: "https://api.example.com/" },
        serve: { baseUrl: "http://localhost:3000" },
        mcp: { enabled: true },
        database: { url: "postgres://localhost/cms" },
        storage: { backend: "local", directory: "./data" },
    });
    expect(config.baseUrl?.href).toBe("http://localhost:3000/");
    expect(config.auth).toMatchObject({ audience: "https://api.example.com/" });
    expect(config.mcp?.authorization?.resource).toBe(
        "https://api.example.com/",
    );
    expect(config.mcp?.url.href).toBe("http://localhost:3000/mcp");
    expect(config.mcp?.authorization?.metadataUrl).toBe(
        "http://localhost:3000/.well-known/oauth-protected-resource/mcp",
    );
});

test("loads explicit no-auth settings from TOML without OAuth configuration", async () => {
    await withFiles(
        minimal.replace(testAuthToml, '[auth]\nkind = "no-auth"\n'),
        "",
        async (configPath, secretsPath) => {
            const config = await ApplicationConfig.fromFiles(
                configPath,
                secretsPath,
            );
            expect(config.auth).toEqual({ kind: "no-auth" });
            expect(config.mcp).toBeUndefined();
        },
    );
    const config = new ApplicationConfig({
        auth: { kind: "no-auth" },
        serve: { baseUrl: "http://localhost:3000" },
        mcp: { enabled: true },
        database: { url: "postgres://localhost/cms" },
        storage: { backend: "local", directory: "./data/blobs" },
    });
    expect(config.mcp?.url.href).toBe("http://localhost:3000/mcp");
    expect(config.mcp?.authorization).toBeUndefined();
});

test.each([
    ["no-auth", false, "127.0.0.1"],
    ["no-auth", true, "127.0.0.1"],
    ["rfc-9068", false, "0.0.0.0"],
    ["rfc-9068", true, "127.0.0.1"],
] as const)("binds %s with bindLocal=%s to %s", (kind, bindLocal, hostname) => {
    const config = new ApplicationConfig({
        auth: kind === "no-auth" ? { kind } : testAuthSettings,
        serve: { bindLocal, baseUrl: "https://cms.example.com" },
        database: { url: "postgres://localhost/cms" },
        storage: { backend: "local", directory: "./data/blobs" },
    });
    expect(config.hostname).toBe(hostname);
});
