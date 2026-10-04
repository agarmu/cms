import * as api from "../api/validation";
import { photo as apiPhoto } from "../api/photos";
import { z } from "zod";

export { uuid } from "../api/validation";
const timestamp = z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value));
export const photo = apiPhoto.extend({ taken: timestamp, posted: timestamp });
export const photoChanges = photo
    .partial()
    .refine((value) =>
        Object.values(value).some((field) => field !== undefined),
    );

export const pagination = z.strictObject({
    limit: z.coerce.number().pipe(api.pagination.shape.limit).default(50),
    offset: z.coerce.number().pipe(api.pagination.shape.offset).default(0),
});
