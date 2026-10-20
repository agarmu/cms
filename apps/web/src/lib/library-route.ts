import { z } from "zod";
import { libraryHome } from "./demo-mode";

export const pageSize = 24;
const photoId = z.uuid();

export function readRoute(url: URL) {
    const rawOffset = url.searchParams.get("offset") ?? "0";
    const parsed = /^\d+$/.test(rawOffset) ? Number(rawOffset) : 0;
    const offset =
        Number.isSafeInteger(parsed) && parsed <= 2_147_483_647 - pageSize
            ? parsed
            : 0;
    const photo = url.searchParams.get("photo");
    return {
        offset,
        photo,
        creating: url.searchParams.has("new"),
        invalidPhoto: photo !== null && !photoId.safeParse(photo).success,
    };
}

export function createPhotoUrl(
    offset: number,
    photo?: string,
    home = libraryHome,
) {
    const library = libraryUrl(offset, photo, home);
    return `${library}${library.includes("?") ? "&" : "?"}new=1`;
}

export function libraryUrl(offset: number, photo?: string, home = libraryHome) {
    const params = new URLSearchParams();
    if (offset > 0) params.set("offset", String(offset));
    if (photo) params.set("photo", photo);
    return params.size ? `${home}?${params}` : home;
}
