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

export class HttpApplication extends Hono {
    constructor(
        options: {
            db: Database;
            reportError: (error: Error) => void;
            getImageStorage: () => ImageStorage;
        },
        config = new HttpConfiguration(),
    ) {
        super();
        Tracing.withSyncSpan("http.app.initialize", () => {
            const withScope = new ScopeMiddleware(options.db).wrap;
            this.use("*", httpInstrumentationMiddleware());
            this.use("*", bodyLimit({ maxSize: config.maxBodyBytes }));
            this.route(
                "/images",
                new ImageUploadRoutes(withScope, options.getImageStorage),
            );
            this.route("/cameras", new EquipmentRoutes(CameraApi, withScope));
            this.route("/lenses", new EquipmentRoutes(LensApi, withScope));
            this.route(
                "/images",
                new PhotoRoutes(withScope, options.getImageStorage),
            );
            this.notFound((context) =>
                context.json({ error: "Route not found" }, 404),
            );
            this.onError(new HttpErrorHandler(options.reportError).handle);
        });
    }
}
