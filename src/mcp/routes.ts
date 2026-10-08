import {
    createMcpHandler,
    validateHostHeader,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AuthEnvironment } from "../http/auth";
import { Scope } from "../api/scope";
import { PhotoMcpServer } from "./server";
import type { McpDependencies } from "./server";
import type { McpConfiguration } from "./config";

export class McpRoutes extends Hono<AuthEnvironment> {
    constructor(options: McpDependencies, maxBodyBytes: number) {
        super();
        this.all("/", async (context) => {
            const identity = context.var.authIdentity;
            const handler = createMcpHandler(
                () => new PhotoMcpServer(options, identity),
                {
                    maxSubscriptions: 0,
                    maxRequestBodySize: maxBodyBytes,
                    onerror: options.reportError,
                },
            );
            return handler.fetch(context.req.raw);
        });
    }

    static metadata(config: McpConfiguration) {
        return {
            resource: config.resource,
            resource_name: "Photos CMS",
            authorization_servers: [config.issuer],
            scopes_supported: [
                Scope.PhotosRead,
                Scope.PhotosCreate,
                Scope.PhotosTextUpdate,
                Scope.PhotosMetadataUpdate,
                Scope.CamerasRead,
                Scope.LensesRead,
            ],
            bearer_methods_supported: ["header"],
        };
    }

    static protect(
        config: McpConfiguration,
    ): MiddlewareHandler<AuthEnvironment> {
        return async (context, next) => {
            const origin = context.req.header("Origin");
            const host =
                context.req.header("Host") ?? new URL(context.req.url).host;
            if (
                !validateHostHeader(host, [config.url.hostname]).ok ||
                new URL(context.req.url).host !== config.url.host ||
                (origin !== undefined && !config.allowedOrigins.has(origin))
            ) {
                return context.json(
                    { error: "Invalid MCP origin or host" },
                    403,
                );
            }
            await next();
            if (context.res.status === 401 || context.res.status === 403) {
                const challenge =
                    context.res.headers.get("WWW-Authenticate") ?? "Bearer";
                context.header(
                    "WWW-Authenticate",
                    `${challenge}${challenge === "Bearer" ? " " : ", "}resource_metadata="${config.metadataUrl}"`,
                );
            }
            return;
        };
    }
}
