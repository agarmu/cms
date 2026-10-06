import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";
import { z } from "zod";
import { Scopes } from "../api/scope";
import type { AuthenticationConfiguration } from "./config";
import {
    AuthenticationError,
    AuthenticationUnavailableError,
} from "./provider";
import type { AuthenticationProvider, AuthIdentity } from "./provider";

export class Rfc9068AuthenticationProvider implements AuthenticationProvider {
    private static readonly claims = z.object({
        sub: z.string().min(1),
        aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
        client_id: z.string().min(1),
        jti: z.string().min(1),
        scope: z
            .string()
            .regex(/^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/)
            .optional(),
    });
    private readonly keys;

    constructor(
        private readonly config: Pick<
            AuthenticationConfiguration,
            "issuer" | "audience" | "jwksUrl"
        >,
    ) {
        this.keys = createRemoteJWKSet(new URL(config.jwksUrl), {
            timeoutDuration: 5000,
            [customFetch]: async (url, options) => {
                try {
                    return await fetch(url, options);
                } catch (cause) {
                    throw new AuthenticationUnavailableError(cause);
                }
            },
        });
    }

    async authenticate(token: string): Promise<AuthIdentity> {
        try {
            const { payload } = await jwtVerify(token, this.keys, {
                issuer: this.config.issuer,
                audience: this.config.audience,
                algorithms: ["RS256"],
                typ: "at+jwt",
                requiredClaims: ["sub", "exp", "iat", "client_id", "jti"],
            });
            const claims =
                Rfc9068AuthenticationProvider.claims.safeParse(payload);
            if (!claims.success) throw new AuthenticationError();
            return {
                subject: claims.data.sub,
                issuer: this.config.issuer,
                scopes: new Set(
                    (claims.data.scope ?? "").split(" ").filter(Scopes.isScope),
                ),
            };
        } catch (error) {
            if (
                error instanceof errors.JWKSTimeout ||
                error instanceof errors.JWKSInvalid ||
                (error instanceof errors.JOSEError &&
                    error.code === "ERR_JOSE_GENERIC")
            ) {
                throw new AuthenticationUnavailableError(error);
            }
            if (error instanceof errors.JOSEError) {
                throw new AuthenticationError();
            }
            throw error;
        }
    }
}
