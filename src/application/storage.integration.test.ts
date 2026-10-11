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
import { fileURLToPath } from "node:url";

test("S3 signing uses file keys and endpoint while allowing Bun's environment session token", async () => {
    const environment = {
        AWS_ACCESS_KEY_ID: "wrong",
        AWS_SECRET_ACCESS_KEY: "wrong",
        AWS_SESSION_TOKEN: "wrong",
        AWS_REGION: "wrong",
        S3_ACCESS_KEY_ID: "wrong",
        S3_SECRET_ACCESS_KEY: "wrong",
        S3_SESSION_TOKEN: "wrong",
        S3_REGION: "wrong",
        S3_BUCKET: "wrong",
        S3_ENDPOINT: "https://wrong.example.com",
    };
    // Bun reads fallback S3 credentials at process startup.
    const child = Bun.spawn(
        [
            process.execPath,
            fileURLToPath(new URL("./fixtures/s3-signing.ts", import.meta.url)),
        ],
        {
            env: { ...process.env, ...environment },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 4000,
        },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const url = new URL(stdout.trim());
    expect(url.hostname).toBe("photos.example.com");
    expect(url.pathname).toBe("/image.png");
    expect(url.searchParams.get("X-Amz-Credential")).toContain("file-key/");
    expect(url.searchParams.get("X-Amz-Credential")).toContain("/auto/s3/");
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("wrong");
});
