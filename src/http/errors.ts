import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { constraintStatus } from "../db/errors";
import { AppError } from "../lib/errors";
import type { ErrorCode } from "../lib/errors";

const applicationStatus = {
    conflict: 409,
    not_found: 404,
} as const satisfies Record<ErrorCode, number>;

export function errorHandler(
    reportError: (error: Error) => void,
): ErrorHandler {
    return (error, context) => {
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
                applicationStatus[error.code],
            );
        }
        const status = constraintStatus(error);
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
        reportError(error);
        return context.json({ error: "Internal server error" }, 500);
    };
}
