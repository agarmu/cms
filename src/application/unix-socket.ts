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
