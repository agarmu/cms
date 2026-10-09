import { Elysia, status } from "elysia";
import { z } from "zod";
import { ApiScope } from "../api/call";
import { ApiValidation } from "../api/validation";
import { CameraApi } from "../api/resources/cameras";
import { LensApi } from "../api/resources/lenses";
import { NotFoundError } from "../lib/errors";
import type { HttpAccess } from "./scope";
import { HttpValidation } from "./validation";

export const equipmentResponse = z.object({
    id: ApiValidation.uuid,
    name: z.string(),
});

export class EquipmentRoutes {
    readonly app;

    constructor(
        prefix: "/api/cameras" | "/api/lenses",
        calls: typeof CameraApi | typeof LensApi,
        access: HttpAccess,
    ) {
        this.app = new Elysia({ prefix })
            .use(access.plugin)
            .get(
                "",
                async ({ db, query }) => ({
                    items: await calls.list(db, query),
                    ...query,
                }),
                {
                    read: ApiScope.getScope(calls.list, "read"),
                    query: HttpValidation.pagination,
                    response: z.object({
                        items: z.array(equipmentResponse),
                        ...ApiValidation.pagination.shape,
                    }),
                },
            )
            .get(
                "/:id",
                async ({ db, params }) => {
                    const [row] = await calls.read(db, params.id);
                    if (!row) throw new NotFoundError("Equipment not found");
                    return row;
                },
                {
                    read: ApiScope.getScope(calls.read, "read"),
                    params: z.object({ id: ApiValidation.uuid }),
                    response: equipmentResponse,
                },
            )
            .delete(
                "/:id",
                async ({ db, params }) => {
                    const [row] = await calls.remove(db, params.id);
                    if (!row) throw new NotFoundError("Equipment not found");
                    return status(204, undefined);
                },
                {
                    write: ApiScope.getScope(calls.remove, "write"),
                    params: z.object({ id: ApiValidation.uuid }),
                    response: { 204: z.undefined() },
                },
            );
    }
}
