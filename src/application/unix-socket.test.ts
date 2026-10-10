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
