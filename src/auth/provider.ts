import type { Scope } from "../api/scope";

export interface AuthIdentity {
    readonly subject: string;
    readonly issuer: string;
    readonly scopes: ReadonlySet<Scope>;
}

export interface AuthenticationProvider {
    readonly scheme: "bearer" | "none";
    authenticate(token?: string): Promise<AuthIdentity>;
}

export class AuthenticationError extends Error {
    constructor() {
        super("A valid bearer access token is required");
    }
}

export class AuthenticationUnavailableError extends Error {
    constructor(cause?: unknown) {
        super("Authentication is temporarily unavailable", { cause });
    }
}
