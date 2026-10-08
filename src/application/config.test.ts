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
        "config.example.toml",
        "secrets.example.toml",
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
