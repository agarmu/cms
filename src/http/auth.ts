import { Elysia } from "elysia";
import { AuthenticationError } from "../auth/provider";
import type { AuthenticationProvider, AuthIdentity } from "../auth/provider";
import { ForbiddenError } from "../lib/errors";

export class HttpAuthentication {
    private readonly identities = new WeakMap<Request, AuthIdentity>();
    readonly plugin;

    constructor(
        provider: AuthenticationProvider,
        allowedSubjects: readonly string[],
        applies: (request: Request) => boolean = () => true,
    ) {
        const allowed = new Set(allowedSubjects);
        this.plugin = new Elysia({ name: "authentication" })
            .onRequest(async ({ request, set }) => {
                if (!applies(request)) return;
                set.headers["Cache-Control"] = "private, no-store";
                const token = /^Bearer +([^\s,]+)$/i.exec(
                    request.headers.get("Authorization") ?? "",
                )?.[1];
                if (provider.scheme === "bearer" && !token)
                    throw new AuthenticationError();
                const identity = await provider.authenticate(token);
                if (!allowed.has(identity.subject))
                    throw new ForbiddenError("Account is not authorized");
                this.identities.set(request, identity);
            })
            .onAfterHandle(({ response, set }) => {
                set.headers["Cache-Control"] = "private, no-store";
                if (response instanceof Response)
                    response.headers.set("Cache-Control", "private, no-store");
            })
            .as("scoped");
    }

    identity(request: Request) {
        const identity = this.identities.get(request);
        if (!identity) throw new AuthenticationError();
        return identity;
    }
}
