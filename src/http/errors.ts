import {
    Elysia,
    ParseError,
    ValidationError,
    NotFoundError,
    status,
} from "elysia";
import {
    InvalidImageError,
    ImageTooLargeError,
} from "../services/image-storage";
import { z } from "zod";
import { DatabaseErrors } from "../db/errors";
import { AppError } from "../lib/errors";
import {
    AuthenticationError,
    AuthenticationUnavailableError,
} from "../auth/provider";
import { InsufficientScopeError } from "./scope";

export class HttpErrorHandler {
    readonly plugin;

    constructor(reportError: (error: Error) => void) {
        this.plugin = new Elysia({ name: "errors" })
            .onError(({ error: caught, request, set }) => {
                const error =
                    caught instanceof ParseError &&
                    caught.cause instanceof Error
                        ? caught.cause
                        : caught;
                if (error instanceof AuthenticationError) {
                    set.headers["WWW-Authenticate"] = request.headers.has(
                        "Authorization",
                    )
                        ? 'Bearer error="invalid_token"'
                        : "Bearer";
                    return status(401, { error: error.message });
                }
                if (error instanceof AuthenticationUnavailableError) {
                    reportError(error);
                    return status(503, { error: error.message });
                }
                if (error instanceof InsufficientScopeError) {
                    set.headers["WWW-Authenticate"] =
                        error.scopes.length === 1
                            ? `Bearer error="insufficient_scope", scope="${error.scopes[0]}"`
                            : 'Bearer error="insufficient_scope"';
                }
                if (error instanceof InvalidImageError)
                    return status(400, { error: error.message });
                if (error instanceof ImageTooLargeError)
                    return status(413, { error: error.message });
                if (error instanceof z.ZodError)
                    return status(400, {
                        error: "Invalid request",
                        issues: error.issues,
                    });
                if (
                    error instanceof ValidationError &&
                    error.type !== "response"
                )
                    return status(400, {
                        error: "Invalid request",
                        issues: error.all,
                    });
                if (error instanceof AppError) {
                    const code = {
                        conflict: 409,
                        not_found: 404,
                        forbidden: 403,
                    } as const;
                    return status(code[error.code], { error: error.message });
                }
                if (caught instanceof ParseError)
                    return status(400, { error: "Invalid request body" });
                if (error instanceof NotFoundError)
                    return status(404, { error: "Route not found" });
                const constraint =
                    error instanceof Error
                        ? DatabaseErrors.constraintStatus(error)
                        : undefined;
                if (constraint === 409)
                    return status(409, {
                        error: "Record conflicts with existing data",
                    });
                if (constraint === 400)
                    return status(400, {
                        error: "Record violates a database constraint",
                    });
                reportError(
                    error instanceof Error ? error : new Error(String(error)),
                );
                return status(500, { error: "Internal server error" });
            })
            .as("global");
    }
}
