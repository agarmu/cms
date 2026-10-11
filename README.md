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

# CMS

A photo CMS with PostgreSQL metadata, local or S3 image storage, an HTTP API, and
MCP tools for uploading photos and editing metadata.

## Quickstart

Follow the [quickstart guide](docs/quickstart.md) to run the CMS locally with
PostgreSQL, local image storage, and no authentication.

## Docker image

Images are published on [GHCR](https://github.com/agarmu/cms/pkgs/container/cms)
for x86-64 Linux. Replace `<tag>` with a published release tag:

```sh
docker pull ghcr.io/agarmu/cms:<tag>
```

The image also works with Podman. Mount your configuration files at
`/app/config.toml` and `/app/secrets.toml`; see the
[configuration reference](docs/configuration.md) for settings.

## Documentation

- [Quickstart](docs/quickstart.md)
- [Configuration reference](docs/configuration.md)
- [HTTP API](docs/http.md)
- [MCP](docs/mcp.md)

## License

The CMS source code, configuration examples, and documentation are licensed
under the GNU General Public License, version 3 or (at your option) any later
version. See [COPYING](COPYING) for the full license text.

This software is distributed without any warranty, including the implied
warranties of merchantability or fitness for a particular purpose.

This license does not apply to photographs or other content stored by the CMS.
Their copyright and usage permissions remain separate. Third-party dependencies
retain their respective licenses.
