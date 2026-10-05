import type { DatabaseFor } from "./database";
import { Scopes } from "./scope";
import type { ReadScope, Scope, WriteScope } from "./scope";

export type Call<S extends Scope, Args extends unknown[], Result> = (
    db: DatabaseFor<S>,
    ...args: Args
) => Promise<Result>;

export class ApiScope {
    private static readonly scopes = new WeakMap<object, Scope>();

    static scoped<const S extends Scope>(requiredScope: S) {
        return function <This, Args extends unknown[], Result>(
            method: (
                this: This,
                db: DatabaseFor<S>,
                ...args: Args
            ) => Promise<Result>,
            _context: ClassMethodDecoratorContext<
                This,
                (
                    this: This,
                    db: DatabaseFor<S>,
                    ...args: Args
                ) => Promise<Result>
            >,
        ) {
            ApiScope.scopes.set(method, requiredScope);
        };
    }

    static getScope(method: object, access: "read"): ReadScope;
    static getScope(method: object, access: "write"): WriteScope;
    static getScope(method: object, access: "read" | "write"): Scope {
        const scope = ApiScope.scopes.get(method);
        if (!scope) throw new Error("API method is missing @scoped");
        if (Scopes.isReadScope(scope) !== (access === "read")) {
            throw new Error(`API method requires a ${access} scope`);
        }
        return scope;
    }
}
