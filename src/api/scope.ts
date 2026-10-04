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

const readScopes = [
    Scope.CamerasRead,
    Scope.LensesRead,
    Scope.ImagesRead,
    Scope.ImageAssetsRead,
] as const;
export type ReadScope = (typeof readScopes)[number];
export type WriteScope = Exclude<Scope, ReadScope>;

const acceptedScopes = new Set<string>(Object.values(Scope));
const readonlyScopes = new Set<Scope>(readScopes);

export function isScope(value: string): value is Scope {
    return acceptedScopes.has(value);
}

export function isReadScope(scope: Scope): scope is ReadScope {
    return readonlyScopes.has(scope);
}
