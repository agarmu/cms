import { Hono } from "hono";
import { validator } from "hono/validator";
import type { Context, Env } from "hono";
import type { z } from "zod";
import { PhotoApi } from "../api/photos";
import { getScope } from "../api/call";
import type { ScopeWrapper } from "./scope";
import * as validation from "./validation";

type PhotoContext<Schema extends z.ZodType> = Context<
    Env,
    string,
    { out: { json: z.output<Schema> } }
>;

export function photoRoutes(withScope: ScopeWrapper) {
    const routes = new Hono();
    routes.get(
        "/",
        withScope(getScope(PhotoApi.list, "read"), async (db, context) => {
            return context.json(
                await PhotoApi.list(
                    db,
                    validation.pagination.parse(context.req.query()),
                ),
            );
        }),
    );
    routes.get(
        "/:id",
        withScope(getScope(PhotoApi.read, "read"), async (db, context) => {
            return context.json(
                await PhotoApi.read(
                    db,
                    validation.uuid.parse(context.req.param("id")),
                ),
            );
        }),
    );
    routes.post(
        "/",
        validator("json", (value) => validation.photo.parse(value)),
        withScope(
            getScope(PhotoApi.create, "write"),
            async (db, context: PhotoContext<typeof validation.photo>) => {
                return context.json(
                    await PhotoApi.create(db, context.req.valid("json")),
                    201,
                );
            },
        ),
    );
    routes.patch(
        "/:id",
        validator("json", (value) => validation.photoChanges.parse(value)),
        withScope(
            getScope(PhotoApi.update, "write"),
            async (
                db,
                context: PhotoContext<typeof validation.photoChanges>,
            ) => {
                const id = validation.uuid.parse(context.req.param("id"));
                return context.json(
                    await PhotoApi.update(db, id, context.req.valid("json")),
                );
            },
        ),
    );
    routes.delete(
        "/:id",
        withScope(getScope(PhotoApi.remove, "write"), async (db, context) => {
            await PhotoApi.remove(
                db,
                validation.uuid.parse(context.req.param("id")),
            );
            return context.body(null, 204);
        }),
    );
    return routes;
}
