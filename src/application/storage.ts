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

import type { BlobStorage } from "../services/blob-storage";
import { LocalStorage } from "../services/local-storage";
import { LocalUploadStorage } from "../services/local-upload-storage";
import { S3Storage } from "../services/s3-storage";
import { StorageConfiguration } from "../services/storage-config";
import { Tracing } from "../telemetry/tracing";

export class StorageFactory {
    constructor(
        private readonly config: StorageConfiguration,
        private readonly uploads?: { baseUrl: URL; maxBytes: number },
    ) {}

    create(): BlobStorage {
        return Tracing.withSyncSpan("storage.initialize", () => {
            Tracing.setSpanAttributes({
                "storage.backend": this.config.backend,
            });
            if (this.config.backend === "local") {
                if (!this.config.directory)
                    throw new Error(
                        "A directory is required for local storage",
                    );
                return this.uploads
                    ? new LocalUploadStorage(
                          this.config.directory,
                          this.uploads.baseUrl,
                          this.uploads.maxBytes,
                      )
                    : new LocalStorage(this.config.directory);
            }
            return new S3Storage(new Bun.S3Client(this.config.clientOptions()));
        });
    }
}
