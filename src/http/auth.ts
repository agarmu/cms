import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { AuthenticationError } from "../auth/provider";
import type { AuthenticationProvider, AuthIdentity } from "../auth/provider";

export type AuthEnvironment = { Variables: { authIdentity: AuthIdentity } };

export class AuthenticationMiddleware {
    private readonly allowedSubjects: ReadonlySet<string>;

    constructor(
        private readonly provider: AuthenticationProvider,
        allowedSubjects: readonly string[],
    ) {
        this.allowedSubjects = new Set(allowedSubjects);
    }

    readonly handle: MiddlewareHandler<AuthEnvironment> = async (
        context,
        next,
    ) => {
        try {
            const token = /^Bearer +([^\s,]+)$/i.exec(
                context.req.header("Authorization") ?? "",
            )?.[1];
            if (!token) throw new AuthenticationError();
            const identity = await this.provider.authenticate(token);
            if (!this.allowedSubjects.has(identity.subject)) {
                throw new HTTPException(403, {
                    message: "Account is not authorized",
                });
            }
            context.set("authIdentity", identity);
            await next();
        } finally {
            context.header("Cache-Control", "private, no-store");
        }
    };
}
