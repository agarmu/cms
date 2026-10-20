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
import { Elysia, ParseError } from "elysia";
import { z } from "zod";
import type { Database, ReadDatabase } from "../api/database";
import type { ReadScope, WriteScope, Scope } from "../api/scope";
import { ForbiddenError } from "../lib/errors";
import type { HttpAuthentication } from "./auth";
import { Tracing } from "../telemetry/tracing";

export class InsufficientScopeError extends ForbiddenError {
    constructor(readonly scopes: readonly Scope[]) {
        super("Insufficient scope");
    }
}

export class HttpAccess {
    readonly plugin;

    constructor(db: Database, auth: HttpAuthentication) {
        const readDb: ReadDatabase = Object.freeze({
            select: db.select.bind(db),
            query: db.query,
        });
        const check = (request: Request, scopes: readonly Scope[]) => {
            const authIdentity = auth.identity(request);
            if (!scopes.some((scope) => authIdentity.scopes.has(scope))) {
                Tracing.setSpanAttributes({
                    "auth.granted_scope_count": authIdentity.scopes.size,
                });
                throw new InsufficientScopeError(scopes);
            }
            return authIdentity;
        };
        const error = z.object({
            error: z.string(),
            issues: z.array(z.unknown()).optional(),
        });
        this.plugin = new Elysia({ name: "scope" })
            .guard({
                as: "scoped",
                response: {
                    400: error,
                    401: error,
                    403: error,
                    404: error,
                    409: error,
                    413: error,
                    500: error,
                    503: error,
                },
            })
            .macro({
                read: (scope: ReadScope) => ({
                    detail: {
                        description: `Requires ${scope}.`,
                        "x-scopes": [scope],
                    },
                    resolve: ({ request }) => ({
                        authIdentity: check(request, [scope]),
                        db: readDb,
                    }),
                }),
                write: (scope: WriteScope | readonly WriteScope[]) => {
                    const scopes = typeof scope === "string" ? [scope] : scope;
                    return {
                        detail: {
                            description: `Requires ${scopes.join(" or ")}.`,
                            "x-scopes": [...scopes],
                        },
                        parse: ({ request, contentType }) => {
                            check(request, scopes);
                            contentType = contentType.trim().toLowerCase();
                            if (
                                request.body &&
                                contentType !== "application/json" &&
                                !(
                                    contentType.startsWith("application/") &&
                                    contentType.endsWith("+json")
                                )
                            )
                                throw new ParseError();
                            if (
                                contentType.startsWith("application/") &&
                                contentType.endsWith("+json")
                            )
                                return request.json();
                            return;
                        },
                        introspect: (options) => {
                            if (options.body && "parse" in options) {
                                options.parse = [
                                    ...(Array.isArray(options.parse)
                                        ? options.parse
                                        : [options.parse]),
                                    "json",
                                ];
                            }
                        },
                        resolve: ({ request }) => ({
                            authIdentity: check(request, scopes),
                            db,
                        }),
                    };
                },
            });
    }
}
