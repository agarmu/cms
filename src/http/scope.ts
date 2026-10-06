import type { MiddlewareHandler } from "hono";
import { ApiScope } from "../api/call";
import type { Database, DatabaseFor, ReadDatabase } from "../api/database";
import { Scopes } from "../api/scope";
import type { Scope, WriteScope } from "../api/scope";
import { AuthenticationError } from "../auth/provider";
import type { AuthEnvironment } from "./auth";

type DatabaseEnvironment<D extends ReadDatabase> = AuthEnvironment & {
    Variables: { db: D };
};

export class ScopeMiddleware {
    private readonly readDb: ReadDatabase;

    constructor(private readonly db: Database) {
        this.readDb = Object.freeze({
            select: db.select.bind(db),
            query: db.query,
        });
    }

    read(method: object) {
        return this.require(ApiScope.getScope(method, "read"));
    }
    write(method: object, ...alternatives: WriteScope[]) {
        return this.check(
            [ApiScope.getScope(method, "write"), ...alternatives],
            this.db,
        );
    }

    require<S extends Scope>(
        scope: S,
    ): MiddlewareHandler<DatabaseEnvironment<DatabaseFor<S>>> {
        return this.check(
            [scope],
            (Scopes.isReadScope(scope)
                ? this.readDb
                : this.db) as DatabaseFor<S>,
        );
    }

    private check<D extends ReadDatabase>(
        scopes: readonly Scope[],
        db: D,
    ): MiddlewareHandler<DatabaseEnvironment<D>> {
        return async (context, next) => {
            const identity = context.get("authIdentity");
            if (!identity) throw new AuthenticationError();
            if (!scopes.some((scope) => identity.scopes.has(scope))) {
                context.header(
                    "WWW-Authenticate",
                    scopes.length === 1
                        ? `Bearer error="insufficient_scope", scope="${scopes[0]}"`
                        : 'Bearer error="insufficient_scope"',
                );
                return context.json({ error: "Insufficient scope" }, 403);
            }
            context.set("db", db);
            await next();
            return;
        };
    }
}
