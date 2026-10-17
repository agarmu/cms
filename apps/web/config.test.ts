import { expect, test } from "bun:test";
import { ApplicationConfig } from "./config";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const settings = {
    api: { baseUrl: "https://cms.example.com/" },
    auth: {
        kind: "oidc",
        issuer: "https://login.example.com/",
        clientId: "public-browser-client",
        scopes: ["openid", "photos:read"],
    },
};

test("public browser configuration rejects client secrets and credentials in URLs", () => {
    for (const invalid of [
        { ...settings, auth: { ...settings.auth, clientSecret: "private" } },
        {
            ...settings,
            api: { baseUrl: "https://user:password@cms.example.com/" },
        },
        {
            ...settings,
            auth: {
                ...settings.auth,
                issuer: "https://user:password@login.example.com/",
            },
        },
    ]) {
        expect(ApplicationConfig.schema.safeParse(invalid).success).toBe(false);
    }
});

test.each([
    "http://cms.example.com/",
    "https://cms.example.com/api",
    "https://cms.example.com/?token=secret",
    "not-a-url",
])("rejects unsafe or ambiguous API URL %s", (baseUrl) => {
    expect(
        ApplicationConfig.schema.safeParse({ ...settings, api: { baseUrl } })
            .success,
    ).toBe(false);
});

test("OIDC configuration requires a public client ID and the openid scope", () => {
    for (const auth of [
        { kind: "oidc", issuer: settings.auth.issuer },
        { ...settings.auth, clientId: " " },
        { ...settings.auth, scopes: ["photos:read"] },
        { ...settings.auth, scopes: ["openid", "photos:read photos:delete"] },
        { kind: "no-auth", issuer: settings.auth.issuer },
    ]) {
        expect(
            ApplicationConfig.schema.safeParse({ ...settings, auth }).success,
        ).toBe(false);
    }
});

test("file-loading errors do not expose supplied configuration values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cms-web-config-"));
    const path = join(directory, "config.toml");
    const privateValue = "private-configuration-value";
    try {
        for (const contents of [
            `[api]\nbaseUrl = "https://user:${privateValue}@cms.example.com/"\n[auth]\nkind = "no-auth"`,
            `[auth]\nclientSecret = "${privateValue}`,
        ]) {
            await Bun.write(path, contents);
            let failure: unknown;
            try {
                await ApplicationConfig.fromFile(path);
            } catch (error) {
                failure = error;
            }
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).not.toContain(privateValue);
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
