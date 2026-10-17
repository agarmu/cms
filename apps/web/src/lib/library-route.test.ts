/// <reference types="bun" />
import { expect, test } from "bun:test";
import { libraryUrl, readRoute } from "./library-route";

const id = "ee15b804-ef9c-4cc3-89a4-3522c9719923";

test("photo links retain their library page across reload and back navigation", () => {
    const href = libraryUrl(24, id);
    expect(readRoute(new URL(href, "https://editor.example.com"))).toEqual({
        offset: 24,
        photo: id,
        invalidPhoto: false,
    });
    expect(libraryUrl(0)).toBe("/");
    expect(libraryUrl(24)).toBe("/?offset=24");
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
