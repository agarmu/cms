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
            .meta(z.toJSONSchema(ApiValidation.pagination.shape.limit))
            .default(50),
        offset: z.coerce
            .number()
            .pipe(ApiValidation.pagination.shape.offset)
            .meta(z.toJSONSchema(ApiValidation.pagination.shape.offset))
            .default(0),
    });
}
