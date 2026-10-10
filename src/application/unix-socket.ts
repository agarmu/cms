import { lstat, unlink } from "node:fs/promises";
import { createConnection } from "node:net";

export async function removeStaleSocket(path: string): Promise<boolean> {
    const before = await lstat(path).catch(() => undefined);
    if (!before?.isSocket()) return false;
    const refused = await new Promise<boolean>((resolve) => {
        const connection = createConnection({ path });
        const finish = (result: boolean) => {
            connection.destroy();
            resolve(result);
        };
        connection.once("connect", () => finish(false));
        connection.once("error", (error: NodeJS.ErrnoException) =>
            finish(error.code === "ECONNREFUSED"),
        );
        connection.setTimeout(1000, () => finish(false));
    });
    if (!refused) return false;
    const current = await lstat(path).catch(() => undefined);
    if (
        !current?.isSocket() ||
        current.dev !== before.dev ||
        current.ino !== before.ino
    )
        return false;
    await unlink(path);
    return true;
}
