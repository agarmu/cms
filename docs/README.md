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

# CMS documentation

A photo CMS with PostgreSQL metadata, local or S3 image storage, an HTTP API, and
MCP tools for uploading photos and editing metadata.

## Quickstart

You need Bun and a running PostgreSQL server. Run commands from the repository root.

### 1. Configure the API

Create a database. Its user must be able to create tables and schemas.
Create or adapt `config.toml` with your database connection details:

```toml
[serve]
baseUrl = "http://localhost:3000"

[auth]
kind = "no-auth"

[database]
url = "postgresql://your-user@localhost:5432/your-database"

[storage]
backend = "local"
directory = "./data/blobs"

[http]
allowedOrigins = ["http://localhost:4321"]

[telemetry]
enabled = false
```

Put the database password in `secrets.toml`:

```toml
[database]
password = "your-password"
```

If no password is needed, create an empty `secrets.toml`.
This setup allows full access without signing in and listens only on localhost.

### 2. Start the API

```sh
bun install --frozen-lockfile
bun run start
```

The API creates its tables and starts at `http://localhost:3000`.
Leave this terminal running.

### 3. Start the website

Create `apps/web/config.toml`:

```toml
[api]
baseUrl = "http://localhost:3000/"

[auth]
kind = "no-auth"
```

In another terminal:

```sh
bun run dev:web
```

Open http://localhost:4321.

## API access

Start the API with `bun run start`.

- **HTTP:** open http://localhost:3000/openapi for the generated reference and
  interactive requests. The raw schema is at `/openapi.json`.
- **MCP:** [enable MCP](configuration.md#mcp), then connect your client to
  `http://localhost:3000/mcp` using Streamable HTTP. Tools are discovered automatically.

Use your server's address for remote access. Supply an access token when
authentication is enabled.

## Docker image

Images are published on [GHCR](https://github.com/agarmu/cms/pkgs/container/cms)
for x86-64 Linux. Replace `<tag>` with a published release tag:

```sh
docker pull ghcr.io/agarmu/cms:<tag>
```

The image also works with Podman. Mount your configuration files at
`/app/config.toml` and `/app/secrets.toml`; see the
[configuration reference](configuration.md) for settings.

## Configuration

See the [configuration reference](configuration.md) for sign-in, storage,
and other settings.

## License

The CMS source code, configuration examples, and documentation are licensed
under the GNU General Public License, version 3 or (at your option) any later
version. See [COPYING](../COPYING) for the full license text.

This software is distributed without any warranty, including the implied
warranties of merchantability or fitness for a particular purpose.

This license does not apply to photographs or other content stored by the CMS.
Their copyright and usage permissions remain separate. Third-party dependencies
retain their respective licenses.
