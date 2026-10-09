import { z } from "zod";
import type { AuthenticationSettings } from "../auth/config";
import { publicUrl } from "../lib/url";

export class McpConfiguration {
    static readonly schema = z.strictObject({
        enabled: z.boolean().default(false),
        allowedOrigins: z
            .array(
                publicUrl.refine(
                    (value) =>
                        URL.canParse(value) && new URL(value).origin === value,
                ),
            )
            .default([]),
    });

    readonly url: URL;
    readonly allowedOrigins: ReadonlySet<string>;
    readonly authorization:
        | {
              resource: string;
              issuer: string;
              metadataUrl: string;
          }
        | undefined;

    constructor(
        baseUrl: URL,
        auth: AuthenticationSettings,
        values: z.input<typeof McpConfiguration.schema> = {},
    ) {
        const settings = McpConfiguration.schema.parse(values);
        this.url = new URL("/mcp", baseUrl);
        this.allowedOrigins = new Set([
            this.url.origin,
            ...settings.allowedOrigins,
        ]);
        if (auth.kind === "no-auth") return;
        const resource = publicUrl.safeParse(auth.audience);
        if (
            !resource.success ||
            new URL(resource.data).origin !== this.url.origin
        ) {
            throw new Error(
                "MCP requires an auth audience URL on its public origin",
            );
        }
        const resourcePath = new URL(resource.data).pathname.replace(/\/$/, "");
        if (resourcePath !== "" && resourcePath !== "/mcp") {
            throw new Error(
                "MCP requires an auth audience identifying the CMS or /mcp",
            );
        }
        this.authorization = {
            resource: resource.data,
            issuer: auth.issuer,
            metadataUrl: new URL(
                "/.well-known/oauth-protected-resource/mcp",
                this.url,
            ).href,
        };
    }
}
