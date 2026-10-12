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

export type BlobUpload = {
    url: string;
    method: "PUT";
    headers: Record<string, string>;
};

export type StoredBlob = {
    size: number;
    stream(): ReadableStream<Uint8Array>;
};

export type BlobDownload = { url: string; expiresAt: Date } | { file: Blob };

export interface BlobStorage {
    // Optional for backends that support clients uploading directly to storage.
    createUpload?(
        key: string,
        contentType: string,
        expiresIn: number,
    ): Promise<BlobUpload>;
    // Read bytes on the server without buffering the entire object.
    get(key: string): Promise<StoredBlob | undefined>;
    // Serve a client through a signed URL or a response body.
    read(key: string, expiresIn: number): Promise<BlobDownload | undefined>;
    write(key: string, data: Uint8Array, contentType: string): Promise<void>;
    // Deleting a missing object must succeed so cleanup can be retried.
    delete(key: string): Promise<void>;
}
