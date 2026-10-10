# Configuration reference

The CMS loads `config.toml` and `secrets.toml` from the working directory at
startup. Both files are required. Unknown keys are rejected.

`config.toml` contains public settings. `secrets.toml` contains the database
password, S3 credentials, and telemetry exporter headers. Examples:
[config.example.toml](../config.example.toml) and
[secrets.example.toml](../secrets.example.toml).

All durations are in milliseconds.

## Serving

Settings in `[serve]`:

| Key         | Default | Description                                                                                          |
| ----------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `port`      | `3000`  | TCP port. `0` requests an allocated port.                                                            |
| `baseUrl`   | Unset   | Public HTTP(S) origin. Required when MCP is enabled or local HTTP upload URLs are used.              |
| `bindLocal` | `false` | Bind TCP to `127.0.0.1` instead of `0.0.0.0`. No-auth mode always binds to `127.0.0.1`.              |
| `unix`      | Unset   | Unix socket path. Replaces TCP; `port` and `bindLocal` are ignored. The parent directory must exist. |

`baseUrl` must use HTTPS unless its host is loopback. Credentials, non-root paths,
queries, and fragments are not accepted. MCP validates the incoming host against
this URL.

TCP example:

```toml
[serve]
port = 3000
baseUrl = "http://localhost:3000"
```

Unix socket example:

```toml
[serve]
unix = "./data/cms.sock"
baseUrl = "https://photos.example.com"
```

For a Unix socket deployment, `baseUrl` is the public origin served by the reverse
proxy. Startup removes abandoned sockets but preserves active listeners and
regular files.

## Authentication

### No authentication

```toml
[auth]
kind = "no-auth"
```

This mode assigns every request the same identity and all scopes. The `[auth]`
table accepts only `kind`; OAuth settings must be removed when switching modes.

### RFC 9068 bearer tokens

Settings in `[auth]`:

| Key               | Requirement                               |
| ----------------- | ----------------------------------------- |
| `kind`            | `"rfc-9068"`                              |
| `issuer`          | Token issuer                              |
| `audience`        | Expected token audience                   |
| `jwksUrl`         | Signing-key endpoint                      |
| `allowedSubjects` | Nonempty list of permitted token subjects |

Tokens must use RS256, have type `at+jwt`, and include `sub`, `exp`, `iat`,
`client_id`, and `jti`. The `sub` claim must be in `allowedSubjects`. Permissions
are taken from the space-separated `scope` claim.

When MCP is enabled, `audience` must be a URL on the same origin as `serve.baseUrl`,
with either the root path or `/mcp`.

## Database

```toml
[database]
url = "postgresql://mukul@localhost:5432/photos-cms"
connectTimeout = 10_000

[database.pool]
maxConnections = 10
idleTimeout = 30_000

[database.tls]
mode = "disable"
```

The timeout, pool, and TLS values shown above are the defaults.

The connection URL must not contain a password, query, or fragment. Configure the
password in `secrets.toml`:

```toml
[database]
password = "your-password"
```

Supported TLS modes: `disable`, `allow`, `prefer`, `require`, `verify-ca`, and
`verify-full`. Database migrations run automatically at startup.

## Storage

Settings in `[storage]`:

| Backend | Required public settings         | Secrets in `[storage]`                                    |
| ------- | -------------------------------- | --------------------------------------------------------- |
| `local` | `backend = "local"`, `directory` | None                                                      |
| `s3`    | `backend = "s3"`, `endpoint`     | `accessKeyId`, `secretAccessKey`; optional `sessionToken` |

### Local storage

```toml
[storage]
backend = "local"
directory = "./data/blobs"
```

HTTP PUT upload URLs require `serve.baseUrl`. They are single-use, expire after
15 minutes, and are invalidated by a restart. MCP uploads do not use these URLs.

### S3 storage

The endpoint must be a bucket-specific, virtual-hosted origin without a path or
query. `region` is optional: recognized AWS endpoints supply the region;
otherwise it defaults to `us-east-1`. Set it explicitly when another provider
requires a different signing region.

## Image processing

Settings in `[images]`:

| Key         | Default                                  | Description                                                              |
| ----------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| `maxBytes`  | `26_214_400`                             | Maximum image file size: 25 MiB. For MCP, applies after base64 decoding. |
| `maxPixels` | `60_000_000`                             | Decoder pixel limit.                                                     |
| `quality`   | `82`                                     | WebP quality, from 1 to 100.                                             |
| `variants`  | large: 1920; medium: 960; thumbnail: 320 | Output variants, specified by name and target shorter side (`minSide`).  |

A variant is skipped if the original's shorter side is below its `minSide`. If
all variants are skipped, processing produces an `original.webp` asset.

## Request limits

`[http].maxBodyBytes` defaults to `65_536` bytes for JSON API requests. Local image
PUTs use `images.maxBytes` instead.

The MCP request-body limit is the larger of `http.maxBodyBytes` and the base64
representation of `images.maxBytes` plus 64 KiB of JSON overhead. Decoded image
bytes must still satisfy `images.maxBytes`.

## Background workers

| Setting                      | Default     | Description                                                                         |
| ---------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `workers.interval`           | `5_000`     | Delay before the first cycle and between one cycle's completion and the next cycle. |
| `workers.batchSize`          | `10`        | Uploads or garbage objects checked per batch.                                       |
| `workers.backoff.maxRetries` | `5`         | Retries after the initial attempt.                                                  |
| `workers.backoff.multiplier` | `2`         | Exponential retry multiplier.                                                       |
| `workers.upload.retryTime`   | `10_000`    | Initial retry delay for both upload processing and garbage collection.              |
| `workers.upload.waitTime`    | `3_600_000` | Wait before failing an upload whose original is missing.                            |

## MCP

Settings in `[mcp]`:

| Key              | Default               | Description                                                                                                     |
| ---------------- | --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `enabled`        | `false`               | Enable the `/mcp` endpoint. Requires `serve.baseUrl`.                                                           |
| `allowedOrigins` | No additional origins | Browser origins permitted in addition to `serve.baseUrl`. Use origin strings without paths or trailing slashes. |

See the [MCP reference](mcp.md) for tools and client configuration.

## Telemetry

Settings in `[telemetry]`:

| Key           | Default        | Description                         |
| ------------- | -------------- | ----------------------------------- |
| `enabled`     | `true`         | Enable telemetry initialization.    |
| `serviceName` | `"photos-cms"` | Service name attached to telemetry. |

The `traces`, `metrics`, and `logs` tables each accept `enabled` (default `false`)
and an OTLP HTTP `endpoint`, required when that signal is enabled.
Exporter headers belong in `[telemetry.<signal>.headers]` in `secrets.toml`.

To disable telemetry:

```toml
[telemetry]
enabled = false
```
