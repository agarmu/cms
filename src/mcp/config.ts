import { z } from "zod";
import type { AuthenticationConfiguration } from "../auth/config";
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
    readonly resource: string;
    readonly issuer: string;
    readonly allowedOrigins: ReadonlySet<string>;
    readonly metadataUrl: string;

    constructor(
        baseUrl: URL,
        auth: Pick<AuthenticationConfiguration, "audience" | "issuer">,
        values: z.input<typeof McpConfiguration.schema> = {},
    ) {
        const settings = McpConfiguration.schema.parse(values);
        this.url = new URL("/mcp", baseUrl);
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
        this.resource = resource.data;
        this.issuer = auth.issuer;
        this.allowedOrigins = new Set([
            this.url.origin,
            ...settings.allowedOrigins,
        ]);
        this.metadataUrl = new URL(
            "/.well-known/oauth-protected-resource/mcp",
            this.url,
        ).href;
    }
}
