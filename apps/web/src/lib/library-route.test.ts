/// <reference types="bun" />
import { expect, test } from "bun:test";
import { createPhotoUrl, libraryUrl, readRoute } from "./library-route";

const id = "ee15b804-ef9c-4cc3-89a4-3522c9719923";

test("photo links retain their library page across reload and back navigation", () => {
    const href = libraryUrl(24, id);
    expect(readRoute(new URL(href, "https://editor.example.com"))).toEqual({
        offset: 24,
        photo: id,
        creating: false,
        invalidPhoto: false,
    });
    expect(libraryUrl(0)).toBe("/");
    expect(libraryUrl(24)).toBe("/?offset=24");
});

test("creation links retain the library page or photo behind the modal", () => {
    expect(
        readRoute(new URL(createPhotoUrl(24), "https://editor.example.com")),
    ).toMatchObject({ offset: 24, photo: null, creating: true });
    const route = readRoute(
        new URL(createPhotoUrl(24, id), "https://editor.example.com"),
    );
    expect(route).toEqual({
        offset: 24,
        photo: id,
        creating: true,
        invalidPhoto: false,
    });
    expect(libraryUrl(route.offset, route.photo ?? undefined)).toBe(
        libraryUrl(24, id),
    );
    expect(readRoute(new URL("https://editor.example.com/")).creating).toBe(
        false,
    );
});

test.each([
    "-24",
    "1.5",
    "Infinity",
    "9999999999999999999999",
    "2147483647",
    "24oops",
])("invalid offset %s falls back to the first page", (offset) => {
    expect(
        readRoute(new URL(`https://editor.example.com/?offset=${offset}`))
            .offset,
    ).toBe(0);
});

test("invalid photo IDs are distinguished from the library route", () => {
    expect(
        readRoute(new URL("https://editor.example.com/?photo=broken"))
            .invalidPhoto,
    ).toBe(true);
    expect(readRoute(new URL("https://editor.example.com/")).invalidPhoto).toBe(
        false,
    );
});
