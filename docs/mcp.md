<!--
This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
-->

# MCP

The CMS exposes a Streamable HTTP MCP endpoint at `/mcp`. It supports photo and
equipment reads, new-photo uploads, and photo metadata updates. Deletion and
image replacement are available only through the [HTTP API](http.md).

## Server configuration

Enable MCP in `config.toml` and set the public origin:

```toml
[serve]
baseUrl = "http://localhost:3000"

[mcp]
enabled = true
```

The request hostname and port must match `serve.baseUrl`. For this check,
`localhost` and `127.0.0.1` are distinct hosts. Browser clients must send an origin
allowed by `serve.baseUrl` or `mcp.allowedOrigins`.

No-auth deployments do not require a token. Authenticated deployments require a
bearer token with the scopes listed below. See the
[configuration reference](configuration.md#authentication) for token requirements.

## Codex configuration

Add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.photos_cms]
url = "http://localhost:3000/mcp"
```

Replace the origin with the CMS public origin. Refresh or restart the MCP
connection after changing server configuration or tools. For authenticated client
setup, see the [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Tools

| Tool                         | Operation                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `list_photos`                | List photo metadata and asset paths                                               |
| `get_photo`                  | Read a photo                                                                      |
| `get_photo_image`            | Retrieve embedded image bytes from local storage or a signed download URL from S3 |
| `create_photo`               | Create a photo from a ready upload                                                |
| `update_photo`               | Update photo text or metadata                                                     |
| `list_cameras`, `get_camera` | List or read cameras                                                              |
| `list_lenses`, `get_lens`    | List or read lenses                                                               |
| `start_photo_upload`         | Create an upload receipt; returns an ID rather than an HTTP upload URL            |
| `upload_photo_image`         | Upload base64-encoded image bytes                                                 |
| `get_photo_upload`           | Read upload status                                                                |
| `get_upload_preview`         | Retrieve a processed upload asset                                                 |
| `complete_photo_upload`      | Process uploaded bytes into WebP assets                                           |
| `cancel_photo_upload`        | Cancel an uncommitted upload                                                      |

List tools accept `limit` (1–100, default 50) and `offset` (default 0).
Photo and equipment reads take `id`; `get_photo_image` also accepts an optional
`filename`, defaulting to the largest asset. `update_photo` takes `id` and a
`changes` object; omitted fields stay unchanged.

## Permissions

| Operation                                 | Required scope                         |
| ----------------------------------------- | -------------------------------------- |
| Read enabled photos or photo images       | `photos:read`                          |
| Also read hidden photos or their images   | `photos:read` and `photos:read:hidden` |
| Read cameras                              | `cameras:read`                         |
| Read lenses                               | `lenses:read`                          |
| Manage new-photo uploads or create photos | `photos:create`                        |
| Update `alt` or `description`             | `photos:text:update`                   |
| Update other photo fields                 | `photos:metadata:update`               |

Updates containing both text and metadata fields require both update scopes.

Without `photos:read:hidden`, hidden (`enabled: false`) photos are omitted from
lists and their metadata and images return not-found errors. The hidden-photo
scope is additive: it does not grant read access without `photos:read`.

## Upload a photo through MCP

The upload is sent through MCP; no separate HTTP PUT request is required. The
following calls upload a PNG and create a photo from the processed image.

### 1. Start the upload

Call `start_photo_upload`:

```json
{ "contentType": "image/png" }
```

Use the returned `id` as `<upload-id>` in subsequent calls.

### 2. Send the image bytes

Call `upload_photo_image`:

```json
{
    "uploadId": "<upload-id>",
    "contentType": "image/png",
    "dataBase64": "<base64-encoded-image-bytes>"
}
```

`dataBase64` must be standard base64 without line breaks or a `data:` prefix.
To encode a file in Bun:

```ts
const bytes = await Bun.file("photo.png").arrayBuffer();
const dataBase64 = Buffer.from(bytes).toString("base64");
```

### 3. Process the image

Call `complete_photo_upload`:

```json
{ "uploadId": "<upload-id>" }
```

A successful result has `status: "ready"` and processed assets. To preview an
asset, call `get_upload_preview` with the upload ID and the asset's filename.

### 4. Create the photo

Call `create_photo`:

```json
{
    "uploadId": "<upload-id>",
    "taken": "2026-10-11T12:00:00Z",
    "posted": "2026-10-11T12:00:00Z",
    "alt": "A description of the photograph",
    "description": "Optional context",
    "enabled": true
}
```

The result contains the photo ID. Optional `camera` and `lens` fields accept
`{ "id": "<equipment-id>" }` or `{ "create": { "name": "Equipment name" } }`.

Uploads belong to the initiating identity. Once processing succeeds (`ready`),
the upload cannot accept more bytes. Creating a photo consumes the receipt and
changes its status to `completed`. To abandon an unconsumed upload, call
`cancel_photo_upload` with its `uploadId`.

## Limits

The default maximum image file size is 25 MiB after base64 decoding. The decoder
also limits images to 60,000,000 pixels. Both values are configurable under
`[images]`; see [image processing](configuration.md#image-processing).

The MCP transport allows enough request-body space for the base64 representation
and JSON overhead. This does not increase the image file-size limit.

## Errors

Tool failures return `isError: true`. Check it before using the result. Metadata
results include `structuredContent`; local image results use image content blocks.

Invalid images, oversized uploads, expired receipts, and ownership conflicts
return explanatory errors. Unexpected failures return `Internal server error`;
the underlying error is logged by the CMS. Authentication, host validation, and
transport limits may reject a request before the tool runs.
