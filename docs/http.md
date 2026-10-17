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

# HTTP API

API routes use the `/api` prefix.

## OpenAPI documentation

With the CMS running locally, open
[http://localhost:3000/openapi.json](http://localhost:3000/openapi.json) to view the
OpenAPI schema. Replace the origin with your server's URL for other deployments.
The endpoint is public and does not require a bearer token. For a rendered API
reference, download the schema and import it into an OpenAPI viewer.

The schema includes operation summaries, route parameters, request bodies,
response schemas, and authentication requirements. Its server URL is `/`,
relative to the origin serving the schema. When importing the file into a hosted
viewer, set the server URL to your CMS origin before sending API requests.
Authenticated deployments still require a bearer token for those requests.

## Authentication and permissions

RFC 9068 deployments require `Authorization: Bearer <access-token>` on API
requests. No-auth deployments do not require a token.

| Operation                                  | Required scope                       |
| ------------------------------------------ | ------------------------------------ |
| Read enabled photos or their assets        | `photos:read`                        |
| Also read hidden photos or their assets    | `photos:read` + `photos:read:hidden` |
| Create photos and manage new-photo uploads | `photos:create`                      |
| Update `alt` or `description`              | `photos:text:update`                 |
| Update other photo fields                  | `photos:metadata:update`             |
| Delete photos                              | `photos:delete`                      |
| Replace photo images                       | `photos:assets:write`                |
| List or read cameras                       | `cameras:read`                       |
| Delete cameras                             | `cameras:delete`                     |
| List or read lenses                        | `lenses:read`                        |
| Delete lenses                              | `lenses:delete`                      |

Updates containing both text and metadata fields require both update scopes.
The photo `enabled` field is metadata. `photos:read` only exposes photos with
`enabled: true`; hidden photos are omitted from lists before pagination and
return 404 for metadata and image downloads. The additive `photos:read:hidden`
scope allows reading hidden photos too, but does not grant read access without
`photos:read`.

## Routes

Path parameters such as `:id` are replaced with resource IDs.

### Photos and equipment

| Method | Path                                  | Operation                           |
| ------ | ------------------------------------- | ----------------------------------- |
| GET    | `/api/photos`                         | List photos                         |
| GET    | `/api/photos/:id`                     | Read photo metadata and asset paths |
| GET    | `/api/photos/:id/image`               | Download the largest asset          |
| GET    | `/api/photos/:id/assets/:filename`    | Download a specific asset           |
| POST   | `/api/photos`                         | Create a photo from a ready upload  |
| PATCH  | `/api/photos/:id`                     | Update text, metadata, or equipment |
| DELETE | `/api/photos/:id`                     | Delete a photo                      |
| GET    | `/api/cameras`, `/api/lenses`         | List equipment                      |
| GET    | `/api/cameras/:id`, `/api/lenses/:id` | Read equipment                      |
| DELETE | `/api/cameras/:id`, `/api/lenses/:id` | Delete equipment                    |

Photo lists accept `limit` (1–100, default 50) and `offset` (default 0).
Downloads return local image bytes or a JSON object containing a signed S3 `url`
and its `expiresAt` timestamp. For S3, load the returned URL separately without
the CMS bearer token. API image paths require the same permissions as metadata.

### New-photo uploads

| Method | Path                                            | Operation                     |
| ------ | ----------------------------------------------- | ----------------------------- |
| POST   | `/api/photo-uploads`                            | Start an upload               |
| GET    | `/api/photo-uploads/:uploadId`                  | Read status and preview paths |
| GET    | `/api/photo-uploads/:uploadId/assets/:filename` | Preview a processed asset     |
| POST   | `/api/photo-uploads/:uploadId/complete`         | Process uploaded bytes        |
| POST   | `/api/photo-uploads/:uploadId/cancel`           | Cancel an uncommitted upload  |

### Image replacement

| Method | Path                                         | Operation                             |
| ------ | -------------------------------------------- | ------------------------------------- |
| POST   | `/api/photos/:id/uploads`                    | Start a replacement                   |
| GET    | `/api/photos/:id/uploads/:uploadId`          | Read replacement status               |
| POST   | `/api/photos/:id/uploads/:uploadId/complete` | Process and attach replacement assets |
| POST   | `/api/photos/:id/uploads/:uploadId/cancel`   | Cancel a pending replacement          |

Replacement completion attaches assets to the existing photo. It does not require
an additional `POST /api/photos` request.

## Upload a new photo

The following example uploads `photo.png` to a local no-auth deployment at
`http://localhost:3000`. For authenticated deployments, add a bearer header to
CMS API calls. The binary PUT uses the headers returned by the upload endpoint,
not the CMS bearer token.

### 1. Start the upload

```sh
curl --fail-with-body http://localhost:3000/api/photo-uploads \
  -H 'Content-Type: application/json' \
  -d '{"contentType":"image/png"}'
```

The response contains `id` and an `upload` object with `url`, `method`, `headers`,
and `expiresIn`. Supported content types are `image/jpeg`, `image/png`,
`image/webp`, `image/avif`, and `image/tiff`.

### 2. Send the image bytes

Replace `<upload-url>` with the returned URL and supply all returned headers.
For the PNG example:

```sh
curl --fail-with-body -X PUT '<upload-url>' \
  -H 'Content-Type: image/png' \
  --data-binary @photo.png
```

Local upload URLs are single-use, expire after 15 minutes, and are invalidated by
a CMS restart. Do not send the CMS bearer token to an S3 upload URL.

### 3. Process the image

Replace `<upload-id>` with the `id` from step 1:

```sh
curl --fail-with-body -X POST \
  'http://localhost:3000/api/photo-uploads/<upload-id>/complete'
```

A successful response has `status: "ready"` and processed WebP assets.
Background workers can also process pending uploads.

### 4. Create the photo

Use the same upload ID:

```sh
curl --fail-with-body http://localhost:3000/api/photos \
  -H 'Content-Type: application/json' \
  -d '{
    "uploadId":"<upload-id>",
    "taken":"2026-10-11T12:00:00Z",
    "posted":"2026-10-11T12:00:00Z",
    "alt":"A description of the photograph",
    "description":"Optional context",
    "enabled":true
  }'
```

The response contains the photo ID. Asset paths are assigned by image processing.
Optional `camera` and `lens` fields accept either `{ "id": "<equipment-id>" }` or
`{ "create": { "name": "Equipment name" } }`.

## Upload lifecycle

Upload statuses are `pending`, `ready`, `completed`, `cancelled`, `failed`, and
`expired`. A new-photo upload becomes `completed` when `POST /api/photos` consumes
its receipt. Upload receipts belong to the initiating identity and cannot be used
by another identity.

## Limits

| Limit                 | Default    |
| --------------------- | ---------- |
| JSON API request body | 64 KiB     |
| Image file size       | 25 MiB     |
| Decoder pixel count   | 60,000,000 |

These limits are configurable; see the [configuration reference](configuration.md).

Local binary uploads use `PUT /api/local-uploads/:token`. This route authenticates
with the temporary upload token, uses the image byte limit, and is omitted from
OpenAPI. Use the returned URL rather than constructing one.

## Errors

| HTTP status | Meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| 400         | Invalid input or image                                                  |
| 401         | Missing or invalid bearer token                                         |
| 403         | Disallowed subject, missing scope, wrong owner, or invalid upload token |
| 404         | Resource not found                                                      |
| 409         | Upload-state or database conflict                                       |
| 413         | Request body or image exceeds its configured limit                      |
| 500         | Unexpected server error; details are logged by the CMS                  |
| 503         | Authentication provider unavailable                                     |
