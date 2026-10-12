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
import { randomUUID } from "node:crypto";
import type { Database } from "./database";
import { DatabaseSchema } from "../db/schema";
import { testAuthIdentity } from "../auth/test-fixtures";
import type { AuthIdentity } from "../auth/provider";
import type { ProcessedAsset } from "../services/image-storage";

export async function readyUpload(
    db: Database,
    assets: ProcessedAsset[] = [
        { width: 640, height: 320, assetLocation: "photo.webp" },
    ],
    identity: AuthIdentity = testAuthIdentity,
) {
    const id = randomUUID();
    await db
        .insert(DatabaseSchema.imageUploads)
        .values({
            id,
            photoId: randomUUID(),
            kind: "creation",
            assets,
            completed: new Date(),
            ownerIssuer: identity.issuer,
            ownerSubject: identity.subject,
        })
        .execute();
    return id;
}
