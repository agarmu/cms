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

import { z } from "zod";

const endpoint = z.url().refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    const secure =
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    return secure && !url.username && !url.password && !url.hash;
}, "Use HTTPS (HTTP is allowed only on loopback), without credentials or fragment");

export class AuthenticationConfiguration {
    static readonly rfc9068 = z.strictObject({
        kind: z.literal("rfc-9068"),
        algorithm: z.enum(["ES256", "ES384", "RS256"]).default("ES256"),
        issuer: endpoint.refine(
            (value) => !value.includes("?"),
            "Issuer cannot contain a query",
        ),
        jwksUrl: endpoint,
        audience: z.string().min(1).regex(/^\S+$/).optional(),
        allowedSubjects: z
            .array(z.string().trim().min(1))
            .min(1)
            .readonly()
            .optional(),
    });
    static readonly schema = z.discriminatedUnion("kind", [
        AuthenticationConfiguration.rfc9068,
        z.strictObject({ kind: z.literal("no-auth") }),
    ]);
}

export type AuthenticationSettings = z.output<
    typeof AuthenticationConfiguration.schema
>;
export type Rfc9068Settings = z.output<
    typeof AuthenticationConfiguration.rfc9068
>;
