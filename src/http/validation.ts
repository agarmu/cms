import { ApiValidation } from "../api/validation";
import { PhotoValidation } from "../api/photos";
import { z } from "zod";

export class HttpValidation {
    static readonly uuid = ApiValidation.uuid;
    private static readonly timestamp = z.iso
        .datetime({ offset: true })
        .transform((value) => new Date(value));
    private static readonly metadata = PhotoValidation.photo
        .omit({ assets: true })
        .extend({
            taken: HttpValidation.timestamp,
            posted: HttpValidation.timestamp,
        });
    static readonly photo = HttpValidation.metadata.extend({
        uploadId: ApiValidation.uuid,
    });
    static readonly photoChanges = HttpValidation.metadata
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
