import { httpInstrumentationMiddleware } from "@hono/otel";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { CameraApi } from "../api/resources/cameras";
import { LensApi } from "../api/resources/lenses";
import type { Database } from "../api/database";
import { PhotoRoutes } from "./photos";
import { EquipmentRoutes } from "./equipment";
import { HttpErrorHandler } from "./errors";
import { ScopeMiddleware } from "./scope";
import { ImageUploadRoutes, PhotoUploadRoutes } from "./image-upload";
import { HttpConfiguration } from "./config";
import type { ImageStorage } from "../services/image-storage";
import { Tracing } from "../telemetry/tracing";
import type { AuthenticationProvider } from "../auth/provider";
import { AuthenticationMiddleware } from "./auth";
import type { AuthEnvironment } from "./auth";
import { cors } from "hono/cors";
import { McpRoutes } from "../mcp/routes";
import type { McpConfiguration } from "../mcp/config";

export class HttpApplication extends Hono<AuthEnvironment> {
    constructor(
        options: {
            db: Database;
            reportError: (error: Error) => void;
            getImageStorage: () => ImageStorage;
            authentication: AuthenticationProvider;
            allowedSubjects: readonly string[];
            mcp?: McpConfiguration | undefined;
        },
        config = new HttpConfiguration(),
    ) {
        super();
        Tracing.withSyncSpan("http.app.initialize", () => {
            const access = new ScopeMiddleware(options.db);
            this.use("*", httpInstrumentationMiddleware());
            if (options.mcp) {
                const mcp = options.mcp;
                for (const path of [
                    "/.well-known/oauth-protected-resource",
                    "/.well-known/oauth-protected-resource/mcp",
                ]) {
                    this.get(path, (context) => {
                        context.header("Access-Control-Allow-Origin", "*");
                        return context.json(McpRoutes.metadata(mcp));
                    });
                }
                this.use("/mcp", McpRoutes.protect(mcp));
                this.use(
                    "/mcp",
                    cors({
                        origin: (origin) =>
                            mcp.allowedOrigins.has(origin) ? origin : undefined,
                        allowMethods: ["POST", "GET", "DELETE", "OPTIONS"],
                        allowHeaders: [
                            "Authorization",
                            "Content-Type",
                            "MCP-Protocol-Version",
                            "MCP-Session-Id",
                            "Mcp-Method",
                            "Mcp-Name",
                        ],
                        exposeHeaders: [
                            "WWW-Authenticate",
                            "MCP-Protocol-Version",
                        ],
                    }),
                );
            }
            this.use(
                "*",
                new AuthenticationMiddleware(
                    options.authentication,
                    options.allowedSubjects,
                ).handle,
            );
            this.use("*", bodyLimit({ maxSize: config.maxBodyBytes }));
            if (options.mcp) {
                this.route("/mcp", new McpRoutes(options, config.maxBodyBytes));
            }
            this.route(
                "/photos",
                new ImageUploadRoutes(access, options.getImageStorage),
            );
            this.route(
                "/photo-uploads",
                new PhotoUploadRoutes(access, options.getImageStorage),
            );
            this.route("/cameras", new EquipmentRoutes(CameraApi, access));
            this.route("/lenses", new EquipmentRoutes(LensApi, access));
            this.route(
                "/photos",
                new PhotoRoutes(access, options.getImageStorage),
            );
            this.notFound((context) =>
                context.json({ error: "Route not found" }, 404),
            );
            this.onError(new HttpErrorHandler(options.reportError).handle);
        });
    }
}
