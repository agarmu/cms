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
