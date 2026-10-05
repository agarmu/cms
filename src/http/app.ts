import { httpInstrumentationMiddleware } from "@hono/otel";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { CameraApi } from "../api/resources/cameras";
import { LensApi } from "../api/resources/lenses";
import type { Database } from "../api/database";
import { photoRoutes } from "./photos";
import { equipmentRoutes } from "./equipment";
import { errorHandler } from "./errors";
import { scopeWrapper } from "./scope";
import { imageUploadRoutes } from "./image-upload";
import type { ImageStorage } from "../services/image-storage";

export function createApp(options: {
    db: Database;
    reportError: (error: Error) => void;
    getImageStorage: () => ImageStorage;
}) {
    const app = new Hono();
    const withScope = scopeWrapper(options.db);
    app.use("*", httpInstrumentationMiddleware());
    const getStorage = options.getImageStorage;

    app.use("*", bodyLimit({ maxSize: 64 * 1024 }));
    app.route("/images", imageUploadRoutes(withScope, getStorage));
    app.route("/cameras", equipmentRoutes(CameraApi, withScope));
    app.route("/lenses", equipmentRoutes(LensApi, withScope));
    app.route("/images", photoRoutes(withScope, getStorage));

    app.notFound((context) => context.json({ error: "Route not found" }, 404));
    app.onError(errorHandler(options.reportError));
    return app;
}
