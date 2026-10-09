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
        issuer: endpoint.refine(
            (value) => !value.includes("?"),
            "Issuer cannot contain a query",
        ),
        audience: z.string().trim().min(1),
        jwksUrl: endpoint,
        allowedSubjects: z.array(z.string().trim().min(1)).min(1).readonly(),
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
