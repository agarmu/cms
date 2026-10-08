import { z } from "zod";

export const publicUrl = z.url().refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
        (url.protocol === "https:" ||
            (url.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
    );
});
