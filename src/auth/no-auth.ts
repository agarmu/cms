import { Scope } from "../api/scope";
import type { AuthenticationProvider, AuthIdentity } from "./provider";

export class NoAuthenticationProvider implements AuthenticationProvider {
    static readonly subject = "no-auth";
    readonly scheme = "none";

    async authenticate(_token?: string): Promise<AuthIdentity> {
        return {
            subject: NoAuthenticationProvider.subject,
            issuer: "urn:photos-cms:no-auth",
            scopes: new Set(Object.values(Scope)),
        };
    }
}
