import { expect, test } from "bun:test";
import { getScope } from "./call";
import { CameraApi } from "./resources/cameras";
import { LensApi } from "./resources/lenses";
import { ImageApi } from "./resources/images";
import { ImageAssetApi } from "./resources/image-assets";
import { Scope } from "./scope";

test.each([
    [CameraApi, Scope.CamerasRead, Scope.CamerasWrite],
    [LensApi, Scope.LensesRead, Scope.LensesWrite],
    [ImageApi, Scope.ImagesRead, Scope.ImagesWrite],
    [ImageAssetApi, Scope.ImageAssetsRead, Scope.ImageAssetsWrite],
] as const)(
    "resource decorators declare the correct scopes (%#)",
    (api, read, write) => {
        expect(getScope(api.list, "read")).toBe(read);
        expect(getScope(api.read, "read")).toBe(read);
        expect(getScope(api.create, "write")).toBe(write);
        expect(getScope(api.update, "write")).toBe(write);
        expect(getScope(api.remove, "write")).toBe(write);
    },
);

test("rejects routes with missing or mismatched scope decorators", () => {
    function undecorated() {}
    expect(() => getScope(undecorated, "read")).toThrow("missing @scoped");
    expect(() => getScope(CameraApi.create, "read")).toThrow(
        "requires a read scope",
    );
    expect(() => getScope(CameraApi.list, "write")).toThrow(
        "requires a write scope",
    );
});
