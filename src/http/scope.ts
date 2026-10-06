import type { MiddlewareHandler } from "hono";
import { ApiScope } from "../api/call";
import type { Database, DatabaseFor, ReadDatabase } from "../api/database";
import { Scopes } from "../api/scope";
import type { Scope } from "../api/scope";
import { AuthenticationError } from "../auth/provider";
import type { AuthEnvironment } from "./auth";

type ScopeEnvironment<S extends Scope> = AuthEnvironment & {
    Variables: { db: DatabaseFor<S> };
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
    write(method: object) {
        return this.require(ApiScope.getScope(method, "write"));
    }

    require<S extends Scope>(scope: S): MiddlewareHandler<ScopeEnvironment<S>> {
        return async (context, next) => {
            const identity = context.get("authIdentity");
            if (!identity) throw new AuthenticationError();
            if (!identity.scopes.has(scope)) {
                context.header(
                    "WWW-Authenticate",
                    `Bearer error="insufficient_scope", scope="${scope}"`,
                );
                return context.json({ error: "Insufficient scope" }, 403);
            }
            context.set(
                "db",
                (Scopes.isReadScope(scope)
                    ? this.readDb
                    : this.db) as DatabaseFor<S>,
            );
            await next();
            return;
        };
    }
}
