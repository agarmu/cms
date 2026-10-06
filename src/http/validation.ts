import { ApiValidation } from "../api/validation";
import { PhotoValidation } from "../api/photos";
import { z } from "zod";

export class HttpValidation {
    static readonly uuid = ApiValidation.uuid;
    private static readonly timestamp = z.iso
        .datetime({ offset: true })
        .transform((value) => new Date(value));
    private static readonly asset = ApiValidation.imageAsset
        .omit({ photoId: true, assetLocation: true })
        .extend({
            filename: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
        })
        .transform(({ filename, ...dimensions }) => ({
            ...dimensions,
            assetLocation: filename,
        }));
    static readonly photo = PhotoValidation.photo.extend({
        taken: HttpValidation.timestamp,
        posted: HttpValidation.timestamp,
        assets: z.array(HttpValidation.asset).optional(),
    });
    static readonly photoChanges = HttpValidation.photo
        .partial()
        .refine((value) =>
            Object.values(value).some((field) => field !== undefined),
        );
    static readonly pagination = z.strictObject({
        limit: z.coerce
            .number()
            .pipe(ApiValidation.pagination.shape.limit)
            .default(50),
        offset: z.coerce
            .number()
            .pipe(ApiValidation.pagination.shape.offset)
            .default(0),
    });
}
