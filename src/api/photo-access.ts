import type { AuthIdentity } from "../auth/provider";
import { ForbiddenError } from "../lib/errors";
import { Scope } from "./scope";

export class PhotoAccess {
    static changeScopes(changes: object): Scope[] {
        return [
            ...new Set(
                Object.keys(changes).map((field) =>
                    field === "alt" || field === "description"
                        ? Scope.PhotosTextUpdate
                        : Scope.PhotosMetadataUpdate,
                ),
            ),
        ];
    }

    static requireChanges(identity: AuthIdentity, changes: object) {
        for (const scope of PhotoAccess.changeScopes(changes)) {
            if (!identity.scopes.has(scope))
                throw new ForbiddenError(
                    `Changing photo fields requires ${scope}`,
                );
        }
    }
}
