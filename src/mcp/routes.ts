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
import {
    createMcpHandler,
    validateHostHeader,
} from "@modelcontextprotocol/server";
import { Elysia, status } from "elysia";
import { cors } from "@elysiajs/cors";
import type { HttpAuthentication } from "../http/auth";
import { HttpErrorHandler } from "../http/errors";
import type { HttpBodyLimit } from "../http/body";
import { Scope } from "../api/scope";
import { PhotoMcpServer } from "./server";
import type { McpDependencies } from "./server";
import type { McpConfiguration } from "./config";

export class McpRoutes {
    readonly app;

    constructor(
        options: McpDependencies,
        config: McpConfiguration,
        auth: HttpAuthentication,
        body: HttpBodyLimit,
        maxBodyBytes: number,
    ) {
        this.app = new Elysia()
            .use(new HttpErrorHandler(options.reportError).plugin)
            .wrap((handle) => async (...args: unknown[]) => {
                const response: unknown = await handle(...args);
                if (!(response instanceof Response))
                    throw new Error("MCP handler returned no response");
                if (
                    config.authorization &&
                    (response.status === 401 || response.status === 403)
                ) {
                    const challenge =
                        response.headers.get("WWW-Authenticate") ?? "Bearer";
                    response.headers.set(
                        "WWW-Authenticate",
                        `${challenge}${challenge === "Bearer" ? " " : ", "}resource_metadata="${config.authorization.metadataUrl}"`,
                    );
                }
                return response;
            })
            .onRequest(({ request }) => {
                const origin = request.headers.get("Origin");
                const host =
                    request.headers.get("Host") ?? new URL(request.url).host;
                if (
                    !validateHostHeader(host, [config.url.hostname]).ok ||
                    new URL(request.url).host !== config.url.host ||
                    (origin !== null && !config.allowedOrigins.has(origin))
                )
                    return status(403, { error: "Invalid MCP origin or host" });
                return;
            })
            .use(
                cors({
                    origin: (request) =>
                        config.allowedOrigins.has(
                            request.headers.get("Origin") ?? "",
                        ),
                    methods: ["POST", "GET", "DELETE", "OPTIONS"],
                    allowedHeaders: [
                        "Authorization",
                        "Content-Type",
                        "MCP-Protocol-Version",
                        "MCP-Session-Id",
                        "Mcp-Method",
                        "Mcp-Name",
                    ],
                    exposeHeaders: ["WWW-Authenticate", "MCP-Protocol-Version"],
                    credentials: false,
                }),
            )
            .use(auth.plugin)
            .use(body.plugin)
            .all(
                "/",
                ({ request }) =>
                    createMcpHandler(
                        () =>
                            new PhotoMcpServer(options, auth.identity(request)),
                        {
                            maxSubscriptions: 0,
                            maxRequestBodySize: maxBodyBytes,
                            onerror: options.reportError,
                        },
                    ).fetch(request),
                { parse: "none", detail: { hide: true } },
            );
    }

    static metadata(config: NonNullable<McpConfiguration["authorization"]>) {
        return {
            resource: config.resource,
            resource_name: "Photos CMS",
            authorization_servers: [config.issuer],
            scopes_supported: [
                Scope.PhotosRead,
                Scope.PhotosReadHidden,
                Scope.PhotosCreate,
                Scope.PhotosTextUpdate,
                Scope.PhotosMetadataUpdate,
                Scope.CamerasRead,
                Scope.LensesRead,
            ],
            bearer_methods_supported: ["header"],
        };
    }
}
