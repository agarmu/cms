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

# Quickstart

Requires Bun and a PostgreSQL database. Run commands from the repository root.

## 1. Create your PostgreSQL database

Create a database and note its host, port, database name, username, and password.

## 2. Configure the CMS

Create `config.toml` with the following contents. Replace the database URL with
your connection details; keep the password out of the URL.

```toml
[serve]
port = 3000
baseUrl = "http://localhost:3000"

[auth]
kind = "no-auth"

[mcp]
enabled = true

[database]
url = "postgresql://your-user@localhost:5432/your-database"

[storage]
backend = "local"
directory = "./data/blobs"

[telemetry]
enabled = false
```

Create `secrets.toml` and put the database password there:

```toml
[database]
password = "your-password"
```

If your database does not require a password, leave `secrets.toml` empty. Both
configuration files must exist.

## 3. Start the app

```sh
bun install --frozen-lockfile
bun run start
```

The CMS applies migrations automatically and listens at `http://localhost:3000`.
This configuration uses local image storage and no authentication, and binds to
loopback. Stop the app with Ctrl-C.

For backend watch mode, run `bun run dev`.

## 4. Open the photo library

Create `apps/web/config.toml` for the separate Astro frontend:

```toml
[api]
baseUrl = "http://localhost:3000/"

[auth]
kind = "no-auth"
```

Add the frontend origin to the backend's root `config.toml` and restart the API:

```toml
[http]
allowedOrigins = ["http://localhost:4321"]
```

Run `bun run dev:web` and open `http://localhost:4321`. The library displays
photos in pages of 24; select a photo to see its image, alt text, dates, and equipment.
The library is empty until photos have been uploaded through the API or MCP.
Photo links retain the selected photo and library page when reloaded or shared.

For authenticated deployments, start from `apps/web/config.example.toml` and
register the frontend's `/` and `/auth/silent` URLs as redirect URIs on your
provider's public browser client. The client needs `openid` and `photos:read`;
add `photos:read:hidden` to include hidden photos. The provider must allow the
frontend origin for token requests and support the API's audience or resource
configuration. Never put a client secret in frontend configuration.

Tokens stay in memory. Reloads attempt silent session recovery; if the provider
or browser blocks it, use Sign in again. Sign out clears this frontend's session;
it does not end the identity provider's session.

Build the frontend with `bun run build:web` and serve it with
`bun run preview:web`. Configuration is compiled into the build, so rebuild after
changing it and allow the preview or deployed frontend origin in `[http].allowedOrigins`.

## API documentation

Open [http://localhost:3000/openapi.json](http://localhost:3000/openapi.json) for
the OpenAPI schema. For a rendered reference, see
[viewing the OpenAPI documentation](http.md#openapi-documentation).

See the [configuration reference](configuration.md) for authentication, S3 storage,
and other settings.
