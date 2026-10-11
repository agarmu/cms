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

import { ApplicationConfig } from "../config";
import { StorageFactory } from "../storage";
import { testAuthSettings } from "../../auth/test-fixtures";

const config = new ApplicationConfig(
    {
        auth: testAuthSettings,
        serve: { baseUrl: "https://cms.example.com" },
        database: { url: "postgres://localhost/cms" },
        storage: {
            backend: "s3",
            endpoint: "https://photos.example.com",
            region: "auto",
        },
    },
    {
        storage: {
            accessKeyId: "file-key",
            secretAccessKey: "file-secret",
        },
    },
);
const storage = new StorageFactory(config.storage).create();
if (!storage.createUpload) throw new Error("Expected direct uploads");
const upload = await storage.createUpload("image.png", "image/png", 60);
console.log(upload.url);
