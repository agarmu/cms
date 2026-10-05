import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { DatabaseErrors } from "../db/errors";
import { AppError } from "../lib/errors";
import type { ErrorCode } from "../lib/errors";

export class HttpErrorHandler {
    private static readonly applicationStatus = {
        conflict: 409,
        not_found: 404,
    } as const satisfies Record<ErrorCode, number>;

    constructor(private readonly reportError: (error: Error) => void) {}

    readonly handle: ErrorHandler = (error, context) => {
        if (error instanceof HTTPException) {
            if (error.res) return error.getResponse();
            return context.json({ error: error.message }, error.status);
        }
        if (error instanceof z.ZodError) {
            return context.json(
                { error: "Invalid request", issues: error.issues },
                400,
            );
        }
        if (error instanceof AppError) {
            return context.json(
                { error: error.message },
                HttpErrorHandler.applicationStatus[error.code],
            );
        }
        const status = DatabaseErrors.constraintStatus(error);
        if (status === 409)
            return context.json(
                { error: "Record conflicts with existing data" },
                status,
            );
        if (status === 400)
            return context.json(
                { error: "Record violates a database constraint" },
                status,
            );
        this.reportError(error);
        return context.json({ error: "Internal server error" }, 500);
    };
}
