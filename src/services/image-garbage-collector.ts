import { and, asc, eq, lte } from "drizzle-orm";
import type { Database } from "../api/database";
import { imageAssetGarbage, imageAssets, images } from "../db/schema";
import type { ImageStorage } from "./image-storage";

export async function collectImageGarbage(options: {
    db: Database;
    getStorage: () => ImageStorage;
    reportError: (error: Error) => void;
}) {
    const garbage = await options.db
        .select()
        .from(imageAssetGarbage)
        .where(lte(imageAssetGarbage.nextCheck, new Date()))
        .orderBy(asc(imageAssetGarbage.nextCheck))
        .limit(10)
        .execute();
    for (const asset of garbage) {
        const key = and(
            eq(imageAssetGarbage.photoId, asset.photoId),
            eq(imageAssetGarbage.assetLocation, asset.assetLocation),
        );
        try {
            const deletionError = await options.db.transaction(async (tx) => {
                // Use the same lock order as photo writes. Hold the photo lock through
                // deletion so an asset cannot be reattached after the reference check.
                await tx
                    .select({ id: images.id })
                    .from(images)
                    .where(eq(images.id, asset.photoId))
                    .for("update")
                    .execute();
                const [queued] = await tx
                    .select()
                    .from(imageAssetGarbage)
                    .where(
                        and(key, lte(imageAssetGarbage.nextCheck, new Date())),
                    )
                    .for("update", { skipLocked: true })
                    .execute();
                if (!queued) return undefined;
                const [referenced] = await tx
                    .select({ id: imageAssets.id })
                    .from(imageAssets)
                    .where(
                        and(
                            eq(imageAssets.photoId, asset.photoId),
                            eq(imageAssets.assetLocation, asset.assetLocation),
                        ),
                    )
                    .limit(1)
                    .execute();
                if (!referenced) {
                    try {
                        await options
                            .getStorage()
                            .deleteAsset(asset.photoId, asset.assetLocation);
                    } catch (error) {
                        // Schedule retries while holding the queue lock. Comparing a database
                        // timestamp with a JavaScript Date would lose microsecond precision.
                        await tx
                            .update(imageAssetGarbage)
                            .set({ nextCheck: new Date(Date.now() + 30_000) })
                            .where(key)
                            .execute();
                        return error instanceof Error
                            ? error
                            : new Error(String(error));
                    }
                }
                // Live objects leave the queue; their next removal will enqueue them again.
                await tx.delete(imageAssetGarbage).where(key).execute();
                return undefined;
            });
            if (deletionError) options.reportError(deletionError);
        } catch (error) {
            options.reportError(
                error instanceof Error ? error : new Error(String(error)),
            );
            // Transaction failures leave the entry due. Blob deletion is idempotent,
            // including if it succeeded before a failed commit.
        }
    }
}
