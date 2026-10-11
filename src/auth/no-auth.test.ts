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
import { Scope } from "../api/scope";
import { NoAuthenticationProvider } from "./no-auth";
import { AuthenticationConfiguration } from "./config";

const provider = new NoAuthenticationProvider();

test("no-auth gives all requests the same owner and all scopes without shared mutable state", async () => {
    const first = await provider.authenticate();
    const second = await provider.authenticate("ignored");
    expect(provider.scheme).toBe("none");
    expect(first).toEqual({
        subject: NoAuthenticationProvider.subject,
        issuer: "urn:photos-cms:no-auth",
        scopes: new Set(Object.values(Scope)),
    });
    expect(second).toEqual(first);
    expect(second.scopes).not.toBe(first.scopes);
});

test("no-auth requires an explicit kind and rejects leftover provider settings", () => {
    expect(
        AuthenticationConfiguration.schema.parse({ kind: "no-auth" }),
    ).toEqual({ kind: "no-auth" });
    for (const settings of [
        {},
        { kind: "none" },
        { kind: "no-auth", issuer: "https://issuer.example.com" },
        { kind: "no-auth", allowedSubjects: ["someone"] },
    ]) {
        expect(
            AuthenticationConfiguration.schema.safeParse(settings).success,
        ).toBe(false);
    }
});
