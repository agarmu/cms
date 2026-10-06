import type { AuthIdentity } from "../auth/provider";
import { ForbiddenError } from "../lib/errors";
import { Scope } from "./scope";

export class PhotoAccess {
    static requireChanges(identity: AuthIdentity, changes: object) {
        for (const field of Object.keys(changes)) {
            const scope =
                field === "assets"
                    ? Scope.PhotosAssetsWrite
                    : field === "alt" || field === "description"
                      ? Scope.PhotosTextUpdate
                      : Scope.PhotosMetadataUpdate;
            if (!identity.scopes.has(scope))
                throw new ForbiddenError(`Changing ${field} requires ${scope}`);
        }
    }
}
