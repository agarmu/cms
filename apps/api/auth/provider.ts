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

import type { Scope } from "../api/scope";

export interface AuthIdentity {
    readonly subject: string;
    readonly issuer: string;
    readonly scopes: ReadonlySet<Scope>;
}

export interface AuthenticationProvider {
    readonly scheme: "bearer" | "none";
    authenticate(token?: string): Promise<AuthIdentity>;
}

export class AuthenticationError extends Error {
    constructor() {
        super("A valid bearer access token is required");
    }
}

export class AuthenticationUnavailableError extends Error {
    constructor(cause?: unknown) {
        super("Authentication is temporarily unavailable", { cause });
    }
}
