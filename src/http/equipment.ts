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
        const singular = prefix === "/api/cameras" ? "camera" : "lens";
        const plural = prefix === "/api/cameras" ? "cameras" : "lenses";
        this.app = new Elysia({ prefix })
            .use(access.plugin)
            .get(
                "",
                async ({ db, query }) => ({
                    items: await calls.list(db, query),
                    ...query,
                }),
                {
                    detail: { summary: `List ${plural}` },
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
                    detail: { summary: `Read a ${singular}` },
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
                    detail: { summary: `Delete a ${singular}` },
                    write: ApiScope.getScope(calls.remove, "write"),
                    params: z.object({ id: ApiValidation.uuid }),
                    response: { 204: z.undefined() },
                },
            );
    }
}
