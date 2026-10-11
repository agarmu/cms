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
