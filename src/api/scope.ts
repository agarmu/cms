export enum Scope {
    CamerasRead = "cameras:read",
    CamerasWrite = "cameras:write",
    LensesRead = "lenses:read",
    LensesWrite = "lenses:write",
    ImagesRead = "images:read",
    ImagesWrite = "images:write",
    ImageAssetsRead = "image-assets:read",
    ImageAssetsWrite = "image-assets:write",
}

export type ReadScope =
    | Scope.CamerasRead
    | Scope.LensesRead
    | Scope.ImagesRead
    | Scope.ImageAssetsRead;
export type WriteScope = Exclude<Scope, ReadScope>;

export class Scopes {
    private static readonly accepted = new Set<string>(Object.values(Scope));
    private static readonly readable = new Set<Scope>([
        Scope.CamerasRead,
        Scope.LensesRead,
        Scope.ImagesRead,
        Scope.ImageAssetsRead,
    ]);

    static isScope(value: string): value is Scope {
        return Scopes.accepted.has(value);
    }
    static isReadScope(scope: Scope): scope is ReadScope {
        return Scopes.readable.has(scope);
    }
}
