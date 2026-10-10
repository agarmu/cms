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
