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
import { McpServer } from "@modelcontextprotocol/server";
import type {
    CallToolResult,
    ScopeChallenge,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AuthIdentity } from "../auth/provider";
import type { Database, ReadDatabase } from "../api/database";
import { ApiScope } from "../api/call";
import { Scope } from "../api/scope";
import { ApiValidation } from "../api/validation";
import { PhotoApi } from "../api/photos";
import { PhotoAccess } from "../api/photo-access";
import { CameraApi } from "../api/resources/cameras";
import { LensApi } from "../api/resources/lenses";
import { ImageUploadApi } from "../api/image-uploads";
import { HttpValidation } from "../http/validation";
import { UploadValidation } from "../http/image-upload";
import { photoResponse, photoUpdateResponse } from "../http/response";
import { DatabaseErrors } from "../db/errors";
import { AppError, NotFoundError } from "../lib/errors";
import {
    InvalidImageError,
    ImageTooLargeError,
} from "../services/image-storage";
import type { ImageStorage } from "../services/image-storage";
import type { BlobDownload } from "../services/blob-storage";

export type McpDependencies = {
    db: Database;
    getImageStorage: () => ImageStorage;
    reportError: (error: Error) => void;
};

const idInput = z.strictObject({ id: ApiValidation.uuid });
const pageInput = ApiValidation.pagination.extend({
    limit: ApiValidation.pagination.shape.limit.default(50),
    offset: ApiValidation.pagination.shape.offset.default(0),
});
const uploadInput = z.strictObject({
    uploadId: ApiValidation.uuid,
});
const updateInput = idInput.extend({ changes: HttpValidation.photoChanges });
const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
};
const write = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
};
const destructive = {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
};

export class PhotoMcpServer extends McpServer {
    private readonly readDb: ReadDatabase;

    constructor(
        private readonly options: McpDependencies,
        private readonly identity: AuthIdentity,
    ) {
        super({ name: "photos-cms", version: "0.0.0" });
        const db = options.db;
        this.readDb = Object.freeze({
            select: db.select.bind(db),
            query: db.query,
        });
        this.registerTool(
            "list_photos",
            {
                description:
                    "List enabled photos with metadata, equipment, and asset paths. Requires photos:read; include hidden photos with photos:read:hidden as well.",
                inputSchema: pageInput,
                scopeChallenge: () =>
                    this.scopeChallenge(
                        ApiScope.getScope(PhotoApi.list, "read"),
                    ),
                annotations: readOnly,
            },
            (page) =>
                this.run(async () => ({
                    items: (
                        await PhotoApi.list(this.readDb, page, this.identity)
                    ).map(photoResponse),
                    ...page,
                })),
        );
        this.registerTool(
            "get_photo",
            {
                description:
                    "Read an enabled photo and its assets. Requires photos:read; hidden photos also require photos:read:hidden.",
                inputSchema: idInput,
                scopeChallenge: () =>
                    this.scopeChallenge(
                        ApiScope.getScope(PhotoApi.read, "read"),
                    ),
                annotations: readOnly,
            },
            ({ id }) =>
                this.run(async () =>
                    photoResponse(
                        await PhotoApi.read(this.readDb, id, this.identity),
                    ),
                ),
        );
        this.registerTool(
            "create_photo",
            {
                description:
                    "Create a photo from your ready upload. Equipment may reference an existing ID or create a new record. Requires photos:create; returns the new ID.",
                inputSchema: HttpValidation.photo,
                scopeChallenge: () =>
                    this.scopeChallenge(
                        ApiScope.getScope(ImageUploadApi.createPhoto, "write"),
                    ),
                annotations: write,
            },
            (input) =>
                this.run(() => ImageUploadApi.createPhoto(db, input, identity)),
        );
        this.registerTool(
            "update_photo",
            {
                description:
                    "Update photo fields. altText, caption, and description require photos:text:update; all other fields require photos:metadata:update. Description is Markdown. Omitted fields stay unchanged. Returns the updated photo only with photos:read (and photos:read:hidden for hidden photos); otherwise returns only its ID.",
                inputSchema: updateInput,
                scopeChallenge: (context) => {
                    const input = updateInput.safeParse(
                        context.request.params?.["arguments"],
                    );
                    if (!input.success) return;
                    return this.scopeChallenge(
                        ...PhotoAccess.changeScopes(input.data.changes),
                    );
                },
                annotations: destructive,
            },
            ({ id, changes }) =>
                this.run(async () => {
                    PhotoAccess.requireChanges(identity, changes);
                    return photoUpdateResponse(
                        await PhotoApi.update(db, id, changes),
                        identity,
                    );
                }),
        );
        this.registerTool(
            "get_photo_image",
            {
                description:
                    "Get a 15-minute signed image URL, or embedded image with local storage. Omit filename for the largest asset. Requires photos:read; hidden photos also require photos:read:hidden.",
                inputSchema: idInput.extend({
                    filename: z.string().min(1).optional(),
                }),
                scopeChallenge: () => this.scopeChallenge(Scope.PhotosRead),
                annotations: readOnly,
            },
            ({ id, filename }) =>
                this.run(async () => {
                    const photo = await PhotoApi.read(
                        this.readDb,
                        id,
                        this.identity,
                    );
                    const asset = filename
                        ? photo.assets.find(
                              (asset) => asset.assetLocation === filename,
                          )
                        : photo.assets.toSorted(
                              (a, b) => b.width * b.height - a.width * a.height,
                          )[0];
                    if (!asset)
                        throw new NotFoundError("Image asset not found");
                    const stored = await options
                        .getImageStorage()
                        .read(photo.id, asset.assetLocation);
                    if (!stored)
                        throw new NotFoundError("Image asset not found");
                    return this.download(stored);
                }),
        );
        for (const [kind, calls] of [
            ["camera", CameraApi],
            ["lens", LensApi],
        ] as const) {
            this.registerTool(
                `list_${kind === "camera" ? "cameras" : "lenses"}`,
                {
                    description: `List existing ${kind} records. Requires ${kind === "camera" ? "cameras" : "lenses"}:read.`,
                    inputSchema: pageInput,
                    scopeChallenge: () =>
                        this.scopeChallenge(
                            ApiScope.getScope(calls.list, "read"),
                        ),
                    annotations: readOnly,
                },
                (page) =>
                    this.run(async () => ({
                        items: await calls.list(this.readDb, page),
                        ...page,
                    })),
            );
            this.registerTool(
                `get_${kind}`,
                {
                    description: `Read a ${kind} record.`,
                    inputSchema: idInput,
                    scopeChallenge: () =>
                        this.scopeChallenge(
                            ApiScope.getScope(calls.read, "read"),
                        ),
                    annotations: readOnly,
                },
                ({ id }) =>
                    this.run(async () => {
                        const [row] = await calls.read(this.readDb, id);
                        if (!row)
                            throw new NotFoundError("Equipment not found");
                        return row;
                    }),
            );
        }
        this.registerTool(
            "start_photo_upload",
            {
                description:
                    "Start an upload for a new photo and return its upload ID. Send base64 image bytes with upload_photo_image, then complete_photo_upload and create_photo. Requires photos:create.",
                inputSchema: UploadValidation.uploadRequest,
                scopeChallenge: () => this.scopeChallenge(Scope.PhotosCreate),
                annotations: write,
            },
            () => this.run(() => ImageUploadApi.createForMcp(db, identity)),
        );
        this.registerTool(
            "upload_photo_image",
            {
                description:
                    "Upload image bytes directly through MCP for your pending upload. dataBase64 must be standard base64 without a data URL prefix. Next call complete_photo_upload. Requires photos:create.",
                inputSchema: uploadInput.extend({
                    contentType:
                        UploadValidation.uploadRequest.shape.contentType,
                    dataBase64: z.string().min(1),
                }),
                scopeChallenge: () => this.scopeChallenge(Scope.PhotosCreate),
                annotations: destructive,
            },
            ({ uploadId, contentType, dataBase64 }) =>
                this.run(() =>
                    ImageUploadApi.uploadOriginal(
                        db,
                        options.getImageStorage(),
                        uploadId,
                        contentType,
                        dataBase64,
                        identity,
                    ),
                ),
        );
        this.registerTool(
            "get_photo_upload",
            {
                description:
                    "Read your new-photo upload's status and preview asset paths. Requires photos:create.",
                inputSchema: uploadInput,
                scopeChallenge: () => this.scopeChallenge(Scope.PhotosCreate),
                annotations: readOnly,
            },
            ({ uploadId }) =>
                this.run(() =>
                    ImageUploadApi.read(this.readDb, uploadId, identity),
                ),
        );
        this.registerTool(
            "complete_photo_upload",
            {
                description:
                    "Process your new-photo upload so it is ready for create_photo. Requires photos:create.",
                inputSchema: uploadInput,
                scopeChallenge: () => this.scopeChallenge(Scope.PhotosCreate),
                annotations: destructive,
            },
            ({ uploadId }) =>
                this.run(() =>
                    ImageUploadApi.finish(
                        db,
                        options.getImageStorage(),
                        uploadId,
                        identity,
                    ),
                ),
        );
        this.registerTool(
            "cancel_photo_upload",
            {
                description:
                    "Cancel your uncommitted new-photo upload. Uploads already used to create a photo cannot be cancelled.",
                inputSchema: uploadInput,
                scopeChallenge: () => this.scopeChallenge(Scope.PhotosCreate),
                annotations: destructive,
            },
            ({ uploadId }) =>
                this.run(() => ImageUploadApi.cancel(db, uploadId, identity)),
        );
        this.registerTool(
            "get_upload_preview",
            {
                description:
                    "Get a signed preview URL (or embedded local image) from your ready new-photo upload. Expires within 15 minutes. Requires photos:create.",
                inputSchema: z.strictObject({
                    uploadId: ApiValidation.uuid,
                    filename: z.string().min(1),
                }),
                scopeChallenge: () => this.scopeChallenge(Scope.PhotosCreate),
                annotations: readOnly,
            },
            ({ uploadId, filename }) =>
                this.run(async () =>
                    this.download(
                        await ImageUploadApi.readAsset(
                            this.readDb,
                            options.getImageStorage(),
                            uploadId,
                            filename,
                            identity,
                        ),
                    ),
                ),
        );
    }

    private async download(stored: BlobDownload): Promise<CallToolResult> {
        if ("url" in stored) return this.result(stored);
        return {
            content: [
                {
                    type: "image",
                    mimeType: stored.file.type,
                    data: Buffer.from(await stored.file.arrayBuffer()).toString(
                        "base64",
                    ),
                },
            ],
        };
    }

    private result(value: object): CallToolResult {
        const text = JSON.stringify(value);
        return {
            content: [{ type: "text", text }],
            structuredContent: JSON.parse(text),
        };
    }

    private scopeChallenge(...scopes: Scope[]): ScopeChallenge | undefined {
        const [first, ...rest] = scopes;
        if (
            first &&
            !scopes.every((scope) => this.identity.scopes.has(scope))
        ) {
            return { scopes: [first, ...rest] };
        }
        return undefined;
    }

    private async run(
        operation: () => Promise<object>,
    ): Promise<CallToolResult> {
        try {
            const result = await operation();
            return "content" in result
                ? (result as CallToolResult)
                : this.result(result);
        } catch (error) {
            let message = "Internal server error";
            if (
                error instanceof AppError ||
                error instanceof InvalidImageError ||
                error instanceof ImageTooLargeError
            ) {
                message = error.message;
            } else if (error instanceof z.ZodError) {
                message = "Invalid tool arguments";
            } else if (
                error instanceof Error &&
                DatabaseErrors.constraintStatus(error)
            ) {
                message =
                    "Record conflicts with existing data or database constraints";
            } else {
                this.options.reportError(
                    error instanceof Error
                        ? error
                        : new Error("MCP tool failed", { cause: error }),
                );
            }
            return {
                content: [{ type: "text", text: message }],
                isError: true,
            };
        }
    }
}
