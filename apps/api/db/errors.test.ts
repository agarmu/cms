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

import { expect, test } from "bun:test";
import { SQL } from "bun";
import { DatabaseErrors } from "./errors";

test("recognizes Bun SQL constraint errors wrapped by Drizzle", () => {
    const cause = new SQL.PostgresError("Foreign key violation", {
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "23503",
    });
    expect(
        DatabaseErrors.constraintStatus(new Error("Query failed", { cause })),
    ).toBe(409);
});

test("recognizes PGlite constraint errors wrapped by Drizzle", () => {
    const cause = Object.assign(new Error("Check violation"), {
        code: "23514",
    });
    expect(
        DatabaseErrors.constraintStatus(new Error("Query failed", { cause })),
    ).toBe(400);
});

test("does not classify connection failures as constraint errors", () => {
    const cause = new SQL.PostgresError("Connection refused", {
        code: "ERR_POSTGRES_CONNECTION_REFUSED",
    });
    expect(
        DatabaseErrors.constraintStatus(new Error("Query failed", { cause })),
    ).toBeUndefined();
});
