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
