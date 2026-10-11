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

import { beforeEach, afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalUploadStorage } from "./local-upload-storage";
import { ImageTooLargeError } from "./image-storage";
import { ForbiddenError } from "../lib/errors";

let directory: string;
let storage: LocalUploadStorage;
const key = `originals/${crypto.randomUUID()}/${crypto.randomUUID()}`;
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "signed-upload-"));
    storage = new LocalUploadStorage(
        directory,
        new URL("http://localhost:3000"),
        4,
    );
});
afterEach(() => rm(directory, { recursive: true, force: true }));
const token = (url: string) => new URL(url).pathname.split("/").at(-1)!;
const active = async () => {};
const request = (body: NonNullable<RequestInit["body"]>) =>
    new Request("http://localhost", {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body,
    });

test("expired upload URLs and tokens from another server are rejected", async () => {
    const expired = await storage.createUpload(key, "image/png", -1);
    await expect(
        storage.receive(token(expired.url), request("abc"), active),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const valid = await storage.createUpload(key, "image/png", 900);
    const restarted = new LocalUploadStorage(
        directory,
        new URL("http://localhost:3000"),
        4,
    );
    await expect(
        restarted.receive(token(valid.url), request("abc"), active),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await storage.get(key)).toBeUndefined();
});

test("streamed oversized uploads leave no file and can be retried", async () => {
    const signed = await storage.createUpload(key, "image/png", 900);
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.enqueue(new Uint8Array([4, 5, 6]));
            controller.close();
        },
    });
    await expect(
        storage.receive(token(signed.url), request(stream), active),
    ).rejects.toBeInstanceOf(ImageTooLargeError);
    expect(await storage.get(key)).toBeUndefined();
    await storage.receive(token(signed.url), request("abc"), active);
    expect(await new Response((await storage.get(key))!.stream()).text()).toBe(
        "abc",
    );
});

test("simultaneous PUTs cannot overwrite the original", async () => {
    const signed = await storage.createUpload(key, "image/png", 900);
    const outcomes = await Promise.allSettled([
        storage.receive(token(signed.url), request("abc"), active),
        storage.receive(token(signed.url), request("xyz"), active),
    ]);
    expect(
        outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const bytes = await new Response((await storage.get(key))!.stream()).text();
    expect(["abc", "xyz"]).toContain(bytes);
});
