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

import { and, asc, eq, isNull, lte } from "drizzle-orm";
import type { Database } from "../api/database";
import { DatabaseSchema } from "../db/schema";
import type { ImageStorage } from "./image-storage";
import { Tracing } from "../telemetry/tracing";
import { WorkerConfiguration } from "./worker-config";

export class ImageGarbageCollector {
    constructor(
        private readonly options: {
            db: Database;
            getStorage: () => ImageStorage;
            reportError: (error: Error) => void;
        },
        private readonly config = new WorkerConfiguration(),
    ) {}

    async collect() {
        return Tracing.withSpan("image.garbage.collect", async () => {
            const garbage = await this.options.db
                .select()
                .from(DatabaseSchema.imageAssetGarbage)
                .where(
                    and(
                        isNull(DatabaseSchema.imageAssetGarbage.failed),
                        lte(
                            DatabaseSchema.imageAssetGarbage.nextCheck,
                            new Date(),
                        ),
                    ),
                )
                .orderBy(asc(DatabaseSchema.imageAssetGarbage.nextCheck))
                .limit(this.config.batchSize)
                .execute();
            Tracing.setSpanAttributes({
                "image.garbage.count": garbage.length,
            });
            for (const asset of garbage) {
                await Tracing.withSpan(
                    "image.garbage.asset",
                    async () => {
                        const key = and(
                            eq(
                                DatabaseSchema.imageAssetGarbage.photoId,
                                asset.photoId,
                            ),
                            eq(
                                DatabaseSchema.imageAssetGarbage.assetLocation,
                                asset.assetLocation,
                            ),
                        );
                        try {
                            const deletionError =
                                await this.options.db.transaction(
                                    async (tx) => {
                                        // Use the same lock order as photo writes. Hold the photo lock through
                                        // deletion so an asset cannot be reattached after the reference check.
                                        await tx
                                            .select({
                                                id: DatabaseSchema.photos.id,
                                            })
                                            .from(DatabaseSchema.photos)
                                            .where(
                                                eq(
                                                    DatabaseSchema.photos.id,
                                                    asset.photoId,
                                                ),
                                            )
                                            .for("update")
                                            .execute();
                                        const [queued] = await tx
                                            .select()
                                            .from(
                                                DatabaseSchema.imageAssetGarbage,
                                            )
                                            .where(
                                                and(
                                                    key,
                                                    isNull(
                                                        DatabaseSchema
                                                            .imageAssetGarbage
                                                            .failed,
                                                    ),
                                                    lte(
                                                        DatabaseSchema
                                                            .imageAssetGarbage
                                                            .nextCheck,
                                                        new Date(),
                                                    ),
                                                ),
                                            )
                                            .for("update", { skipLocked: true })
                                            .execute();
                                        if (!queued) {
                                            Tracing.setSpanAttributes({
                                                "job.outcome": "skipped",
                                            });
                                            return undefined;
                                        }
                                        const [referenced] = await tx
                                            .select({
                                                id: DatabaseSchema.imageAssets
                                                    .id,
                                            })
                                            .from(DatabaseSchema.imageAssets)
                                            .where(
                                                and(
                                                    eq(
                                                        DatabaseSchema
                                                            .imageAssets
                                                            .photoId,
                                                        asset.photoId,
                                                    ),
                                                    eq(
                                                        DatabaseSchema
                                                            .imageAssets
                                                            .assetLocation,
                                                        asset.assetLocation,
                                                    ),
                                                ),
                                            )
                                            .limit(1)
                                            .execute();
                                        if (!referenced) {
                                            try {
                                                await this.options
                                                    .getStorage()
                                                    .deleteAsset(
                                                        asset.photoId,
                                                        asset.assetLocation,
                                                    );
                                            } catch (error) {
                                                // Schedule retries while holding the queue lock. Comparing a database
                                                // timestamp with a JavaScript Date would lose microsecond precision.
                                                const delay =
                                                    this.config.retryDelay(
                                                        queued.retryCount,
                                                    );
                                                await tx
                                                    .update(
                                                        DatabaseSchema.imageAssetGarbage,
                                                    )
                                                    .set(
                                                        delay === undefined
                                                            ? {
                                                                  failed: "Asset deletion exhausted its retry limit",
                                                              }
                                                            : {
                                                                  retryCount:
                                                                      queued.retryCount +
                                                                      1,
                                                                  nextCheck:
                                                                      new Date(
                                                                          Date.now() +
                                                                              delay,
                                                                      ),
                                                              },
                                                    )
                                                    .where(key)
                                                    .execute();
                                                Tracing.setSpanAttributes({
                                                    "job.outcome":
                                                        delay === undefined
                                                            ? "failed"
                                                            : "retry",
                                                    "job.retry_delay_ms":
                                                        delay ?? 0,
                                                });
                                                return error instanceof Error
                                                    ? error
                                                    : new Error(String(error));
                                            }
                                        }
                                        // Live objects leave the queue; their next removal will enqueue them again.
                                        await tx
                                            .delete(
                                                DatabaseSchema.imageAssetGarbage,
                                            )
                                            .where(key)
                                            .execute();
                                        Tracing.setSpanAttributes({
                                            "job.outcome": referenced
                                                ? "retained"
                                                : "deleted",
                                        });
                                        return undefined;
                                    },
                                );
                            if (deletionError) {
                                Tracing.recordSpanError(deletionError);
                                this.options.reportError(deletionError);
                            }
                        } catch (error) {
                            Tracing.recordSpanError(error);
                            Tracing.setSpanAttributes({
                                "job.outcome": "retry",
                            });
                            this.options.reportError(
                                error instanceof Error
                                    ? error
                                    : new Error(String(error)),
                            );
                            // Transaction failures leave the entry due. Blob deletion is idempotent,
                            // including if it succeeded before a failed commit.
                        }
                    },
                    { "photo.id": asset.photoId },
                );
            }
        });
    }
}
