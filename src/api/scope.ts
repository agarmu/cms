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
export enum Scope {
    CamerasRead = "cameras:read",
    CamerasCreate = "cameras:create",
    CamerasUpdate = "cameras:update",
    CamerasDelete = "cameras:delete",
    LensesRead = "lenses:read",
    LensesCreate = "lenses:create",
    LensesUpdate = "lenses:update",
    LensesDelete = "lenses:delete",
    PhotosRead = "photos:read",
    PhotosReadHidden = "photos:read:hidden",
    PhotosCreate = "photos:create",
    PhotosTextUpdate = "photos:text:update",
    PhotosMetadataUpdate = "photos:metadata:update",
    PhotosAssetsWrite = "photos:assets:write",
    PhotosDelete = "photos:delete",
    ImageAssetsRead = "image-assets:read",
    ImageAssetsWrite = "image-assets:write",
}

export type ReadScope =
    | Scope.CamerasRead
    | Scope.LensesRead
    | Scope.PhotosRead
    | Scope.PhotosReadHidden
    | Scope.ImageAssetsRead;
export type WriteScope = Exclude<Scope, ReadScope>;

export class Scopes {
    private static readonly accepted = new Set<string>(Object.values(Scope));
    private static readonly readable = new Set<Scope>([
        Scope.CamerasRead,
        Scope.LensesRead,
        Scope.PhotosRead,
        Scope.PhotosReadHidden,
        Scope.ImageAssetsRead,
    ]);

    static isScope(value: string): value is Scope {
        return Scopes.accepted.has(value);
    }
    static isReadScope(scope: Scope): scope is ReadScope {
        return Scopes.readable.has(scope);
    }
}
