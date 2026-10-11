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
import { ApiScope } from "./call";
import { CameraApi } from "./resources/cameras";
import { LensApi } from "./resources/lenses";
import { ImageApi } from "./resources/images";
import { ImageAssetApi } from "./resources/image-assets";
import { Scope } from "./scope";

test.each([
    [
        CameraApi,
        Scope.CamerasRead,
        Scope.CamerasCreate,
        Scope.CamerasUpdate,
        Scope.CamerasDelete,
    ],
    [
        LensApi,
        Scope.LensesRead,
        Scope.LensesCreate,
        Scope.LensesUpdate,
        Scope.LensesDelete,
    ],
    [
        ImageApi,
        Scope.PhotosRead,
        Scope.PhotosCreate,
        Scope.PhotosMetadataUpdate,
        Scope.PhotosDelete,
    ],
    [
        ImageAssetApi,
        Scope.ImageAssetsRead,
        Scope.ImageAssetsWrite,
        Scope.ImageAssetsWrite,
        Scope.ImageAssetsWrite,
    ],
] as const)(
    "resource decorators declare the correct scopes (%#)",
    (api, read, create, update, remove) => {
        expect(ApiScope.getScope(api.list, "read")).toBe(read);
        expect(ApiScope.getScope(api.read, "read")).toBe(read);
        expect(ApiScope.getScope(api.create, "write")).toBe(create);
        expect(ApiScope.getScope(api.update, "write")).toBe(update);
        expect(ApiScope.getScope(api.remove, "write")).toBe(remove);
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
