import { expect, test } from "bun:test";
import { McpConfiguration } from "./config";
import { testAuthSettings } from "../auth/test-fixtures";

test("derives MCP and discovery URLs from the public base URL", () => {
    const config = new McpConfiguration(
        new URL("https://cms.example.com"),
        testAuthSettings,
    );
    expect(config.url.href).toBe("https://cms.example.com/mcp");
    expect(config.authorization?.metadataUrl).toBe(
        "https://cms.example.com/.well-known/oauth-protected-resource/mcp",
    );
    expect(config.authorization?.resource).toBe(testAuthSettings.audience);
    expect(config.allowedOrigins).toEqual(new Set(["https://cms.example.com"]));
});

test("requires an audience for the same CMS and allows loopback development", () => {
    for (const audience of [
        "cms",
        "https://another.example.com/",
        "https://cms.example.com/unrelated",
    ]) {
        expect(
            () =>
                new McpConfiguration(new URL("https://cms.example.com"), {
                    ...testAuthSettings,
                    audience,
                }),
        ).toThrow("MCP requires");
    }
    expect(
        new McpConfiguration(new URL("http://localhost:3000"), {
            ...testAuthSettings,
            audience: "http://localhost:3000/mcp",
        }).url.href,
    ).toBe("http://localhost:3000/mcp");
});
