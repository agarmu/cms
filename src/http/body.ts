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
//
import { Elysia } from "elysia";
import { ImageTooLargeError } from "../services/image-storage";

export class HttpBodyLimit {
    readonly plugin;

    constructor(
        maxBytes: number,
        applies: (request: Request) => boolean = () => true,
    ) {
        this.plugin = new Elysia({ name: "body-limit", seed: maxBytes })
            .onRequest(async ({ request }) => {
                if (!applies(request)) return;
                if (Number(request.headers.get("Content-Length")) > maxBytes)
                    throw new ImageTooLargeError("Request body is too large");
                const reader = request.clone().body?.getReader();
                if (!reader) return;
                let bytes = 0;
                try {
                    for (;;) {
                        const chunk = await reader.read();
                        if (chunk.done) break;
                        bytes += chunk.value.byteLength;
                        if (bytes > maxBytes) {
                            void reader.cancel().catch(() => {});
                            void request.body?.cancel().catch(() => {});
                            throw new ImageTooLargeError(
                                "Request body is too large",
                            );
                        }
                    }
                } finally {
                    reader.releaseLock();
                }
            })
            .as("scoped");
    }
}
