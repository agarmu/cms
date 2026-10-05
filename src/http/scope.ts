import type { Context, Env, Handler, Input } from "hono";
import { Scopes } from "../api/scope";
import type { Scope } from "../api/scope";
import type { Database, DatabaseFor, ReadDatabase } from "../api/database";

export class ScopeMiddleware {
    private readonly readDb: ReadDatabase;

    constructor(private readonly db: Database) {
        this.readDb = Object.freeze({
            select: db.select.bind(db),
            query: db.query,
        });
    }

    readonly wrap = <const S extends Scope, I extends Input = Input>(
        scope: S,
        fn: (
            db: DatabaseFor<NoInfer<S>>,
            context: Context<Env, string, I>,
        ) => Promise<Response>,
    ): Handler<Env, string, I> => {
        return (context) =>
            fn(
                (Scopes.isReadScope(scope)
                    ? this.readDb
                    : this.db) as DatabaseFor<S>,
                context,
            );
    };
}

export type ScopeWrapper = ScopeMiddleware["wrap"];
