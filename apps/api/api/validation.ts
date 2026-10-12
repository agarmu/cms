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
import type { UUID } from "node:crypto";
import { z } from "zod";

export class ApiValidation {
    static readonly uuid = z.uuid().transform((value) => value as UUID);
    private static readonly positiveInteger = z
        .int()
        .positive()
        .max(2_147_483_647);
    static readonly assetId = ApiValidation.positiveInteger;
    static readonly equipment = z.strictObject({
        name: z.string().trim().min(1),
    });
    static readonly image = z.strictObject({
        taken: z.date(),
        posted: z.date(),
        alt: z.string(),
        description: z.string(),
        enabled: z.boolean(),
        cameraId: ApiValidation.uuid.nullable().optional(),
        lensId: ApiValidation.uuid.nullable().optional(),
    });
    static readonly imageAsset = z.strictObject({
        photoId: ApiValidation.uuid,
        width: ApiValidation.positiveInteger,
        height: ApiValidation.positiveInteger,
        assetLocation: z.string().min(1),
    });

    static readonly pagination = z.strictObject({
        limit: z.int().min(1).max(100),
        offset: z.int().min(0).max(2_147_483_647),
    });
    private static hasChanges(value: object) {
        return Object.values(value).some((field) => field !== undefined);
    }
    static readonly equipmentChanges = ApiValidation.equipment
        .partial()
        .refine(ApiValidation.hasChanges);
    static readonly imageChanges = ApiValidation.image
        .partial()
        .refine(ApiValidation.hasChanges);
    static readonly imageAssetChanges = ApiValidation.imageAsset
        .partial()
        .refine(ApiValidation.hasChanges);
}
