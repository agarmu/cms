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
    static readonly schema = z.strictObject({
        kind: z.literal("rfc-9068"),
        issuer: endpoint.refine(
            (value) => !value.includes("?"),
            "Issuer cannot contain a query",
        ),
        audience: z.string().trim().min(1),
        jwksUrl: endpoint,
        allowedSubjects: z.array(z.string().trim().min(1)).min(1),
    });

    readonly issuer: string;
    readonly kind: "rfc-9068";
    readonly audience: string;
    readonly jwksUrl: string;
    readonly allowedSubjects: readonly string[];

    constructor(values: z.input<typeof AuthenticationConfiguration.schema>) {
        const settings = AuthenticationConfiguration.schema.parse(values);
        this.kind = settings.kind;
        this.issuer = settings.issuer;
        this.audience = settings.audience;
        this.jwksUrl = settings.jwksUrl;
        this.allowedSubjects = Object.freeze(settings.allowedSubjects);
    }
}
