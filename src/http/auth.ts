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
import { Elysia } from "elysia";
import { AuthenticationError } from "../auth/provider";
import type { AuthenticationProvider, AuthIdentity } from "../auth/provider";
import { ForbiddenError } from "../lib/errors";

export class HttpAuthentication {
    private readonly identities = new WeakMap<Request, AuthIdentity>();
    readonly plugin;

    constructor(
        provider: AuthenticationProvider,
        allowedSubjects: readonly string[],
        applies: (request: Request) => boolean = () => true,
    ) {
        const allowed = new Set(allowedSubjects);
        this.plugin = new Elysia({ name: "authentication" })
            .onRequest(async ({ request, set }) => {
                if (!applies(request)) return;
                set.headers["Cache-Control"] = "private, no-store";
                const token = /^Bearer +([^\s,]+)$/i.exec(
                    request.headers.get("Authorization") ?? "",
                )?.[1];
                if (provider.scheme === "bearer" && !token)
                    throw new AuthenticationError();
                const identity = await provider.authenticate(token);
                if (!allowed.has(identity.subject))
                    throw new ForbiddenError("Account is not authorized");
                this.identities.set(request, identity);
            })
            .onAfterHandle(({ response, set }) => {
                set.headers["Cache-Control"] = "private, no-store";
                if (response instanceof Response)
                    response.headers.set("Cache-Control", "private, no-store");
            })
            .as("scoped");
    }

    identity(request: Request) {
        const identity = this.identities.get(request);
        if (!identity) throw new AuthenticationError();
        return identity;
    }
}
