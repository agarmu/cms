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

export const testAuthSettings = {
    kind: "rfc-9068" as const,
    algorithm: "ES256" as const,
    issuer: "https://issuer.example.com/",
    audience: "https://cms.example.com/",
    jwksUrl: "https://issuer.example.com/.well-known/jwks.json",
    allowedSubjects: ["test-user"],
};
export const testAuthIdentity: AuthIdentity = {
    subject: "test-user",
    issuer: testAuthSettings.issuer,
    scopes: new Set(Object.values(Scope)),
};
export const testAuthentication: AuthenticationProvider = {
    scheme: "bearer",
    authenticate: async () => testAuthIdentity,
};
export const testAuthDependencies = {
    authentication: testAuthentication,
    allowedSubjects: testAuthSettings.allowedSubjects,
};
export const testAuthToml = `
[auth]
kind = "rfc-9068"
algorithm = "${testAuthSettings.algorithm}"
issuer = "${testAuthSettings.issuer}"
audience = "${testAuthSettings.audience}"
jwksUrl = "${testAuthSettings.jwksUrl}"
allowedSubjects = ["test-user"]
`;

export function requestAsUser(
    app: { fetch: (request: Request) => Response | Promise<Response> },
    path: string,
    init: RequestInit = {},
) {
    const headers = new Headers(init.headers);
    headers.set("Authorization", "Bearer test-token");
    return requestApp(app, path, { ...init, headers });
}

export function requestApp(
    app: { fetch: (request: Request) => Response | Promise<Response> },
    path: string,
    init?: RequestInit,
) {
    return app.fetch(
        new Request(new URL(path, "http://localhost").href, init ?? {}),
    );
}
