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
