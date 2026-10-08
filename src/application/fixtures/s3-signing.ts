import { ApplicationConfig } from "../config";
import { StorageFactory } from "../storage";
import { testAuthSettings } from "../../auth/test-fixtures";

const config = new ApplicationConfig(
    {
        auth: testAuthSettings,
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
