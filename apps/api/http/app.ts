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
import { Elysia } from "elysia";
import { HttpOpenApi } from "./openapi";
import { HttpTelemetry } from "./telemetry";
import { CameraApi } from "../api/resources/cameras";
import { LensApi } from "../api/resources/lenses";
import type { Database } from "../api/database";
import { PhotoRoutes } from "./photos";
import { EquipmentRoutes } from "./equipment";
import { HttpErrorHandler } from "./errors";
import { HttpAccess } from "./scope";
import { ImageUploadRoutes, PhotoUploadRoutes } from "./image-upload";
import { HttpConfiguration } from "./config";
import { HttpBodyLimit } from "./body";
import type { ImageStorage } from "../services/image-storage";
import { Tracing } from "../telemetry/tracing";
import type { AuthenticationProvider } from "../auth/provider";
import { HttpAuthentication } from "./auth";
import { McpRoutes } from "../mcp/routes";
import type { McpConfiguration } from "../mcp/config";
import type { LocalUploadStorage } from "../services/local-upload-storage";
import { ImageUploadApi } from "../api/image-uploads";
import { NotFoundError } from "../lib/errors";
import { ImageConfiguration } from "../services/image-config";

export class HttpApplication {
    readonly app;
    readonly fetch = (request: Request) => this.app.handle(request);

    constructor(
        options: {
            db: Database;
            reportError: (error: Error) => void;
            getImageStorage: () => ImageStorage;
            getLocalUploads?: () => LocalUploadStorage | undefined;
            imageConfig?: ImageConfiguration | undefined;
            authentication: AuthenticationProvider;
            allowedSubjects: readonly string[];
            mcp?: McpConfiguration | undefined;
        },
        config = new HttpConfiguration(),
    ) {
        this.app = Tracing.withSyncSpan("http.app.initialize", () => {
            const publicPaths = new Set(["/openapi.json"]);
            if (options.mcp) publicPaths.add("/mcp");
            if (options.mcp?.authorization)
                for (const path of [
                    "/.well-known/oauth-protected-resource",
                    "/.well-known/oauth-protected-resource/mcp",
                ])
                    publicPaths.add(path);
            const protectedRequest = (request: Request) => {
                const path = new URL(request.url).pathname.replace(/\/$/, "");
                if (
                    request.method === "PUT" &&
                    /^\/api\/local-uploads\/[^/]+$/.test(path)
                )
                    return false;
                return !publicPaths.has(path);
            };
            const auth = new HttpAuthentication(
                options.authentication,
                options.allowedSubjects,
                protectedRequest,
            );
            const access = new HttpAccess(options.db, auth);
            const body = new HttpBodyLimit(
                config.maxBodyBytes,
                protectedRequest,
            );
            const routes = new Elysia()
                .use(auth.plugin)
                .use(body.plugin)
                .use(new ImageUploadRoutes(access, options.getImageStorage).app)
                .use(new PhotoUploadRoutes(access, options.getImageStorage).app)
                .use(new EquipmentRoutes("/api/cameras", CameraApi, access).app)
                .use(new EquipmentRoutes("/api/lenses", LensApi, access).app)
                .use(new PhotoRoutes(access, options.getImageStorage).app);
            const app = new Elysia()
                .use(new HttpTelemetry().plugin)
                .use(new HttpErrorHandler(options.reportError).plugin)
                .put(
                    "/api/local-uploads/:token",
                    async ({ params, request }) => {
                        const storage = options.getLocalUploads?.();
                        if (!storage)
                            throw new NotFoundError(
                                "Local uploads are unavailable",
                            );
                        await storage.receive(params.token, request, (key) =>
                            ImageUploadApi.requirePendingOriginal(
                                options.db,
                                key,
                            ),
                        );
                        return new Response(null, { status: 204 });
                    },
                    { parse: "none", detail: { hide: true } },
                )
                .get("/openapi.json", () =>
                    HttpOpenApi.document(routes, options.authentication.scheme),
                )
                .use(routes);
            if (options.mcp) {
                const mcp = options.mcp;
                const maxMcpBytes = Math.max(
                    config.maxBodyBytes,
                    (options.imageConfig ?? new ImageConfiguration())
                        .mcpMaxBodyBytes,
                );
                const authorization = mcp.authorization;
                if (authorization)
                    for (const path of [
                        "/.well-known/oauth-protected-resource",
                        "/.well-known/oauth-protected-resource/mcp",
                    ]) {
                        app.get(
                            path,
                            ({ set }) => {
                                set.headers["Access-Control-Allow-Origin"] =
                                    "*";
                                return McpRoutes.metadata(authorization);
                            },
                            { detail: { hide: true } },
                        );
                    }
                app.mount(
                    "/mcp",
                    new McpRoutes(
                        options,
                        mcp,
                        new HttpAuthentication(
                            options.authentication,
                            options.allowedSubjects,
                        ),
                        new HttpBodyLimit(maxMcpBytes),
                        maxMcpBytes,
                    ).app,
                );
            }
            return app;
        });
    }
}
