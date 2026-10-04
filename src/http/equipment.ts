import { Hono } from "hono";
import { CameraApi } from "../api/resources/cameras";
import { LensApi } from "../api/resources/lenses";
import { getScope } from "../api/call";
import { NotFoundError } from "../lib/errors";
import type { ScopeWrapper } from "./scope";
import { pagination, uuid } from "./validation";

// Equipment can be browsed and explicitly removed, but only created through photos.
export function equipmentRoutes(
    calls: typeof CameraApi | typeof LensApi,
    withScope: ScopeWrapper,
) {
    const routes = new Hono();
    routes.get(
        "/",
        withScope(getScope(calls.list, "read"), async (db, context) => {
            return context.json(
                await calls.list(db, pagination.parse(context.req.query())),
            );
        }),
    );
    routes.get(
        "/:id",
        withScope(getScope(calls.read, "read"), async (db, context) => {
            const [row] = await calls.read(
                db,
                uuid.parse(context.req.param("id")),
            );
            if (!row) throw new NotFoundError("Equipment not found");
            return context.json(row);
        }),
    );
    routes.delete(
        "/:id",
        withScope(getScope(calls.remove, "write"), async (db, context) => {
            const [row] = await calls.remove(
                db,
                uuid.parse(context.req.param("id")),
            );
            if (!row) throw new NotFoundError("Equipment not found");
            return context.body(null, 204);
        }),
    );
    return routes;
}
