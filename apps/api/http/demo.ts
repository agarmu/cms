import { Elysia } from "elysia";
import { z } from "zod";
import type { ReadDatabase } from "../api/database";
import { PhotoApi } from "../api/photos";
import { CameraApi } from "../api/resources/cameras";
import { LensApi } from "../api/resources/lenses";
import type { ImageStorage } from "../services/image-storage";
import { NotFoundError } from "../lib/errors";
import { HttpValidation } from "./validation";
import { equipmentResponse } from "./equipment";
import {
    assetUrl,
    downloadResponse,
    downloadSchema,
    photoResponse,
    photoSchema,
} from "./response";

export type DemoReadDependencies = {
    db: ReadDatabase;
    getImageStorage: () => ImageStorage;
};

export const isDemoApiPath = (path: string) =>
    path === "/api/demo" || path.startsWith("/api/demo/");

export class DemoRoutes {
    readonly app;

    constructor({ db, getImageStorage }: DemoReadDependencies) {
        const params = z.object({ id: HttpValidation.uuid });
        const detail = { security: [], tags: ["Demo"] };
        const respond = (photo: Awaited<ReturnType<typeof PhotoApi.read>>) => {
            const response = photoResponse(photo);
            return {
                ...response,
                assets: response.assets.map((asset) => ({
                    ...asset,
                    url: assetUrl(photo.id, asset.filename, "/api/demo/photos"),
                })),
            };
        };
        this.app = new Elysia({ prefix: "/api/demo" })
            .get(
                "/photos",
                async ({ query }) => ({
                    items: (await PhotoApi.list(db, query)).map(respond),
                    ...query,
                }),
                {
                    detail: { ...detail, summary: "List demo photos" },
                    query: HttpValidation.pagination,
                    response: z.object({
                        items: z.array(photoSchema),
                        limit: z.number(),
                        offset: z.number(),
                    }),
                },
            )
            .get(
                "/photos/:id",
                async ({ params }) =>
                    respond(await PhotoApi.read(db, params.id)),
                {
                    detail: { ...detail, summary: "Read a demo photo" },
                    params,
                    response: photoSchema,
                },
            )
            .get(
                "/photos/:id/assets/:filename",
                async ({ params }) => {
                    const photo = await PhotoApi.read(db, params.id);
                    if (
                        !photo.assets.some(
                            (asset) => asset.assetLocation === params.filename,
                        )
                    )
                        throw new NotFoundError("Demo image asset not found");
                    const stored = await getImageStorage().read(
                        photo.id,
                        params.filename,
                    );
                    if (!stored)
                        throw new NotFoundError("Demo image asset not found");
                    return downloadResponse(stored);
                },
                {
                    detail: {
                        ...detail,
                        summary: "Download a demo photo asset",
                    },
                    params: params.extend({ filename: z.string() }),
                    response: downloadSchema,
                },
            )
            .get(
                "/cameras",
                async ({ query }) => ({
                    items: await CameraApi.list(db, query),
                    ...query,
                }),
                {
                    detail: { ...detail, summary: "List demo cameras" },
                    query: HttpValidation.pagination,
                    response: z.object({
                        items: z.array(equipmentResponse),
                        limit: z.number(),
                        offset: z.number(),
                    }),
                },
            )
            .get(
                "/lenses",
                async ({ query }) => ({
                    items: await LensApi.list(db, query),
                    ...query,
                }),
                {
                    detail: { ...detail, summary: "List demo lenses" },
                    query: HttpValidation.pagination,
                    response: z.object({
                        items: z.array(equipmentResponse),
                        limit: z.number(),
                        offset: z.number(),
                    }),
                },
            );
    }
}
