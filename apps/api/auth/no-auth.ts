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

import { Scope } from "../api/scope";
import type { AuthenticationProvider, AuthIdentity } from "./provider";

export class NoAuthenticationProvider implements AuthenticationProvider {
    static readonly subject = "no-auth";
    readonly scheme = "none";

    async authenticate(_token?: string): Promise<AuthIdentity> {
        return {
            subject: NoAuthenticationProvider.subject,
            issuer: "urn:photos-cms:no-auth",
            scopes: new Set(Object.values(Scope)),
        };
    }
}
