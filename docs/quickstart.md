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

## API documentation

Open [http://localhost:3000/openapi.json](http://localhost:3000/openapi.json) for
the OpenAPI schema. For a rendered reference, see
[viewing the OpenAPI documentation](http.md#openapi-documentation).

See the [configuration reference](configuration.md) for authentication, S3 storage,
and other settings.
