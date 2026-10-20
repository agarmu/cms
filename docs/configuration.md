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

# Configuration reference

| File                                             | Example                                   |
| ------------------------------------------------ | ----------------------------------------- |
| `config.toml` — API settings                     | [API example](config.example.toml)        |
| `secrets.toml` — passwords and keys              | [Secrets example](secrets.example.toml)   |
| `apps/web/config.toml` — public website settings | [Frontend example](frontend.example.toml) |

Both API files must exist; `secrets.toml` may be empty. The API requires
`[auth]`, `[database]`, and `[storage]`. Unknown settings are rejected.
Restart the API after changes; rebuild the website after frontend changes.
Durations are in milliseconds. Paths are relative to the working directory.

## Serving

| `[serve]` setting | Default | Purpose                                                                 |
| ----------------- | ------- | ----------------------------------------------------------------------- |
| `baseUrl`         | Unset   | Public API URL; required for access tokens, MCP, and local HTTP uploads |
| `port`            | `3000`  | TCP port                                                                |
| `bindLocal`       | `false` | Listen only on localhost; always enabled without authentication         |
| `unix`            | Unset   | Unix socket path instead of TCP                                         |

Use HTTPS except on localhost. `baseUrl` must be an origin, such as
`https://cms.example.com`, without a path or query.

## Authentication

Use `[auth] kind = "no-auth"` for local access without signing in. Remove all
other `[auth]` fields in this mode.

### Access tokens

For sign-in, configure your provider:

```toml
[auth]
kind = "rfc-9068"
issuer = "https://auth.example.com/"
jwksUrl = "https://auth.example.com/.well-known/jwks.json"
```

| Setting           | Default                             | Purpose                                             |
| ----------------- | ----------------------------------- | --------------------------------------------------- |
| `algorithm`       | `"ES256"`                           | Signing algorithm; also accepts `ES384` and `RS256` |
| `audience`        | `serve.baseUrl` with a trailing `/` | API identifier registered with your provider        |
| `allowedSubjects` | Unrestricted                        | Limit access to a list of user IDs (`sub`)          |

Tokens must follow RFC 9068, including type `at+jwt`, and match the configured
issuer, audience, and algorithm. Permissions come from the token's `scope` claim.

## Database

Set `[database].url` to a PostgreSQL URL without a password or query. Put the
password in `[database].password` in `secrets.toml`.

| Setting                        | Default     |
| ------------------------------ | ----------- |
| `database.connectTimeout`      | `10_000`    |
| `database.pool.maxConnections` | `10`        |
| `database.pool.idleTimeout`    | `30_000`    |
| `database.tls.mode`            | `"disable"` |

TLS modes: `disable`, `allow`, `prefer`, `require`, `verify-ca`, `verify-full`.
Tables are migrated at startup; the database user must be able to create schemas
and tables. See the [database schema](schema.txt) for table definitions.

## Storage

### Local storage

```toml
[storage]
backend = "local"
directory = "./data/blobs"
```

### S3 storage

```toml
[storage]
backend = "s3"
endpoint = "https://your-bucket.s3.us-east-1.amazonaws.com"
```

Use a bucket-specific endpoint. Set `region` if needed; it is inferred for AWS
endpoints and otherwise defaults to `us-east-1`. Put `accessKeyId`,
`secretAccessKey`, and optional `sessionToken` in `secrets.toml` under `[storage]`.
For browser uploads, allow the website's origin to PUT with `Content-Type` in
the bucket's CORS policy.

## HTTP and CORS

Allow your website's origin to call the API:

```toml
[http]
allowedOrigins = ["http://localhost:4321"]
```

The list defaults to empty. Origins include scheme, hostname, and port, without
a path or trailing slash. `http.maxBodyBytes` defaults to `65_536` for JSON;
image uploads use `images.maxBytes`.

## Image processing

| `[images]` setting | Default                                  |
| ------------------ | ---------------------------------------- |
| `maxBytes`         | `26_214_400` (25 MiB)                    |
| `maxPixels`        | `60_000_000`                             |
| `quality`          | `82`                                     |
| `variants`         | large: 1920, medium: 960, thumbnail: 320 |

Uploads become WebP images at full resolution and the configured sizes.
Variant sizes measure the shorter side; images too small for a size skip it.
Set sizes with `[[images.variants]]` entries containing `name` and `minSide`.
These replace the defaults; `variants = []` keeps only full resolution.
The name `original` is reserved. Original uploaded bytes are not retained.

## Background workers

Workers finish pending uploads and remove unused image files.

| Setting                      | Default     |
| ---------------------------- | ----------- |
| `workers.interval`           | `5_000`     |
| `workers.batchSize`          | `10`        |
| `workers.backoff.maxRetries` | `5`         |
| `workers.backoff.multiplier` | `2`         |
| `workers.upload.retryTime`   | `10_000`    |
| `workers.upload.waitTime`    | `3_600_000` |

## MCP

`[mcp].enabled` defaults to `false`. Enabling it requires `serve.baseUrl`.
Browser clients can use `[mcp].allowedOrigins` to allow origins beyond that URL.
See [API access](README.md#api-access) to connect a client.

## Telemetry

`[telemetry].enabled` defaults to `true`; `serviceName` defaults to `"photos-cms"`.
For each of `traces`, `metrics`, and `logs`, set `enabled = true` and an OTLP HTTP
`endpoint` under `[telemetry.<signal>]`. Export headers go in `secrets.toml`
under `[telemetry.<signal>.headers]`. Signals default to disabled.

## Frontend configuration

These settings go in `apps/web/config.toml` and are embedded in the website.

| Setting         | Required or default                                         |
| --------------- | ----------------------------------------------------------- |
| `api.baseUrl`   | Required; API origin                                        |
| `auth.kind`     | Required; `"no-auth"` or `"oidc"`                           |
| `auth.issuer`   | Required for OIDC; provider issuer URL                      |
| `auth.clientId` | Required for OIDC; public browser client ID                 |
| `auth.scopes`   | `["openid", "photos:read"]`; must include `openid`          |
| `auth.resource` | Optional; API identifier for providers using this parameter |
| `auth.audience` | Optional; API identifier for providers using this parameter |

With `no-auth`, remove the other `[auth]` settings. For sign-in, register a public
browser client with `/` and `/auth/silent` on your website as redirect URLs.
Allow the website's origin in API `[http].allowedOrigins`.

Build with `bun run build:web` and serve `apps/web/dist/`. Rebuild after changing
frontend settings.

## Frontend demo

Create a separate database and image store, then add to `config.toml`:

```toml
[demo.database]
url = "postgres://demo-user@localhost:5432/photos_cms_demo"

[demo.storage]
backend = "local"
directory = "./data/demo-blobs"
```

Put its password in `secrets.toml` under `[demo.database]`. Database and storage
options work like their main-library counterparts.

Restart the API to create the tables, then import sample records and matching
images. Keep the demo database's own `photos_cms_internal.database_identity`
row when importing; copying the main identity prevents startup.

Everything in this database is public, including hidden photos. Put photo
credits and licenses in each description.
