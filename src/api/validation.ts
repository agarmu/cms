import type { UUID } from "node:crypto";
import { z } from "zod";
export const uuid = z.uuid().transform((value) => value as UUID);
const positiveInteger = z.int().positive().max(2_147_483_647);
export const assetId = positiveInteger;
export const equipment = z.strictObject({ name: z.string().trim().min(1) });
export const image = z.strictObject({
    taken: z.date(),
    posted: z.date(),
    alt: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    cameraId: uuid.nullable().optional(),
    lensId: uuid.nullable().optional(),
});
export const imageAsset = z.strictObject({
    photoId: uuid,
    width: positiveInteger,
    height: positiveInteger,
    assetLocation: z.string().min(1),
});

export const pagination = z.strictObject({
    limit: z.int().min(1).max(100),
    offset: z.int().min(0).max(2_147_483_647),
});
function hasChanges(value: object) {
    return Object.values(value).some((field) => field !== undefined);
}
export const equipmentChanges = equipment.partial().refine(hasChanges);
export const imageChanges = image.partial().refine(hasChanges);
export const imageAssetChanges = imageAsset.partial().refine(hasChanges);
