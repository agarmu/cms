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

export class DatabaseErrors {
    static constraintStatus(error: Error): 400 | 409 | undefined {
        const cause: unknown = error.cause ?? error;
        if (typeof cause !== "object" || cause === null) return undefined;
        const code =
            "errno" in cause && typeof cause.errno === "string"
                ? cause.errno
                : "code" in cause
                  ? cause.code
                  : undefined;
        if (code === "23503" || code === "23505") return 409;
        if (code === "23514" || code === "23502") return 400;
        return undefined;
    }
}
