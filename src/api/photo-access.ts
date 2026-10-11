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
