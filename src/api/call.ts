import type { DatabaseFor } from "./database";
import { isReadScope } from "./scope";
import type { ReadScope, Scope, WriteScope } from "./scope";

export type Call<S extends Scope, Args extends unknown[], Result> = (
    db: DatabaseFor<S>,
    ...args: Args
) => Promise<Result>;

const scopes = new WeakMap<object, Scope>();

export function scoped<const S extends Scope>(requiredScope: S) {
    return function <This, Args extends unknown[], Result>(
        method: (
            this: This,
            db: DatabaseFor<S>,
            ...args: Args
        ) => Promise<Result>,
        _context: ClassMethodDecoratorContext<
            This,
            (this: This, db: DatabaseFor<S>, ...args: Args) => Promise<Result>
        >,
    ) {
        scopes.set(method, requiredScope);
    };
}

export function getScope(method: object, access: "read"): ReadScope;
export function getScope(method: object, access: "write"): WriteScope;
export function getScope(method: object, access: "read" | "write"): Scope {
    const scope = scopes.get(method);
    if (!scope) throw new Error("API method is missing @scoped");
    if (isReadScope(scope) !== (access === "read")) {
        throw new Error(`API method requires a ${access} scope`);
    }
    return scope;
}
