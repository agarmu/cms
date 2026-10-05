import { Hono } from "hono";
import { CameraApi } from "../api/resources/cameras";
import { LensApi } from "../api/resources/lenses";
import { ApiScope } from "../api/call";
import { NotFoundError } from "../lib/errors";
import type { ScopeWrapper } from "./scope";
import { HttpValidation } from "./validation";

// Equipment can be browsed and explicitly removed, but only created through photos.
export class EquipmentRoutes extends Hono {
    constructor(
        calls: typeof CameraApi | typeof LensApi,
        withScope: ScopeWrapper,
    ) {
        super();
        this.get(
            "/",
            withScope(
                ApiScope.getScope(calls.list, "read"),
                async (db, context) => {
                    return context.json(
                        await calls.list(
                            db,
                            HttpValidation.pagination.parse(
                                context.req.query(),
                            ),
                        ),
                    );
                },
            ),
        );
        this.get(
            "/:id",
            withScope(
                ApiScope.getScope(calls.read, "read"),
                async (db, context) => {
                    const [row] = await calls.read(
                        db,
                        HttpValidation.uuid.parse(context.req.param("id")),
                    );
                    if (!row) throw new NotFoundError("Equipment not found");
                    return context.json(row);
                },
            ),
        );
        this.delete(
            "/:id",
            withScope(
                ApiScope.getScope(calls.remove, "write"),
                async (db, context) => {
                    const [row] = await calls.remove(
                        db,
                        HttpValidation.uuid.parse(context.req.param("id")),
                    );
                    if (!row) throw new NotFoundError("Equipment not found");
                    return context.body(null, 204);
                },
            ),
        );
    }
}
