import { Hono } from "hono";
import { CameraApi } from "../api/resources/cameras";
import { LensApi } from "../api/resources/lenses";
import { NotFoundError } from "../lib/errors";
import type { ScopeMiddleware } from "./scope";
import { HttpValidation } from "./validation";
import type { AuthEnvironment } from "./auth";

// Equipment can be browsed and explicitly removed, but only created through photos.
export class EquipmentRoutes extends Hono<AuthEnvironment> {
    constructor(
        calls: typeof CameraApi | typeof LensApi,
        access: ScopeMiddleware,
    ) {
        super();
        this.get("/", access.read(calls.list), async (context) => {
            const db = context.var.db;
            const page = HttpValidation.pagination.parse(context.req.query());
            return context.json({ items: await calls.list(db, page), ...page });
        });
        this.get("/:id", access.read(calls.read), async (context) => {
            const db = context.var.db;
            const [row] = await calls.read(
                db,
                HttpValidation.uuid.parse(context.req.param("id")),
            );
            if (!row) throw new NotFoundError("Equipment not found");
            return context.json(row);
        });
        this.delete("/:id", access.write(calls.remove), async (context) => {
            const db = context.var.db;
            const [row] = await calls.remove(
                db,
                HttpValidation.uuid.parse(context.req.param("id")),
            );
            if (!row) throw new NotFoundError("Equipment not found");
            return context.body(null, 204);
        });
    }
}
