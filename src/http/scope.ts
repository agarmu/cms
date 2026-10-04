import type { Context, Env, Handler, Input } from "hono";
import { isReadScope } from "../api/scope";
import type { Scope } from "../api/scope";
import type { Database, DatabaseFor, ReadDatabase } from "../api/database";

export function scopeWrapper(db: Database) {
    const readDb: ReadDatabase = Object.freeze({
        select: db.select.bind(db),
        query: db.query,
    });
    return function withScope<const S extends Scope, I extends Input = Input>(
        scope: S,
        fn: (
            db: DatabaseFor<NoInfer<S>>,
            context: Context<Env, string, I>,
        ) => Promise<Response>,
    ): Handler<Env, string, I> {
        // All requests have access; scopes determine which database capabilities are passed.
        return (context) =>
            fn((isReadScope(scope) ? readDb : db) as DatabaseFor<S>, context);
    };
}

export type ScopeWrapper = ReturnType<typeof scopeWrapper>;
