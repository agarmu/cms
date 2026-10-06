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
import { ImageUploadRoutes } from "./image-upload";
import { HttpConfiguration } from "./config";
import type { ImageStorage } from "../services/image-storage";
import { Tracing } from "../telemetry/tracing";
import type { AuthenticationProvider } from "../auth/provider";
import { AuthenticationMiddleware } from "./auth";
import type { AuthEnvironment } from "./auth";

export class HttpApplication extends Hono<AuthEnvironment> {
    constructor(
        options: {
            db: Database;
            reportError: (error: Error) => void;
            getImageStorage: () => ImageStorage;
            authentication: AuthenticationProvider;
            allowedSubjects: readonly string[];
        },
        config = new HttpConfiguration(),
    ) {
        super();
        Tracing.withSyncSpan("http.app.initialize", () => {
            const access = new ScopeMiddleware(options.db);
            this.use("*", httpInstrumentationMiddleware());
            this.use(
                "*",
                new AuthenticationMiddleware(
                    options.authentication,
                    options.allowedSubjects,
                ).handle,
            );
            this.use("*", bodyLimit({ maxSize: config.maxBodyBytes }));
            this.route(
                "/photos",
                new ImageUploadRoutes(access, options.getImageStorage),
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
