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

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeStaleSocket } from "./unix-socket";

test("stale socket recovery preserves active listeners, files, and symlinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uds-"));
    const unix = join(directory, "s");
    const server = Bun.serve({ unix, fetch: () => new Response("active") });
    try {
        expect(await removeStaleSocket(unix)).toBe(false);
        expect(await (await fetch("http://localhost", { unix })).text()).toBe(
            "active",
        );
        const file = join(directory, "file");
        await writeFile(file, "sentinel");
        expect(await removeStaleSocket(file)).toBe(false);
        expect(await readFile(file, "utf8")).toBe("sentinel");
        const link = join(directory, "link");
        await symlink(unix, link);
        expect(await removeStaleSocket(link)).toBe(false);
        expect(await removeStaleSocket(join(directory, "missing"))).toBe(false);
    } finally {
        await server.stop(true);
        await rm(directory, { recursive: true, force: true });
    }
});
