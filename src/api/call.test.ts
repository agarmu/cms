import { expect, test } from "bun:test";
import { ApiScope } from "./call";
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
        expect(ApiScope.getScope(api.list, "read")).toBe(read);
        expect(ApiScope.getScope(api.read, "read")).toBe(read);
        expect(ApiScope.getScope(api.create, "write")).toBe(write);
        expect(ApiScope.getScope(api.update, "write")).toBe(write);
        expect(ApiScope.getScope(api.remove, "write")).toBe(write);
    },
);

test("rejects routes with missing or mismatched scope decorators", () => {
    function undecorated() {}
    expect(() => ApiScope.getScope(undecorated, "read")).toThrow(
        "missing @scoped",
    );
    expect(() => ApiScope.getScope(CameraApi.create, "read")).toThrow(
        "requires a read scope",
    );
    expect(() => ApiScope.getScope(CameraApi.list, "write")).toThrow(
        "requires a write scope",
    );
});
