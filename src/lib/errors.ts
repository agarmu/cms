export type ErrorCode = "conflict" | "auth_unavailable";

/** Expected application failures whose messages are safe to show to callers. */
export class AppError extends Error {
    constructor(
        readonly code: ErrorCode,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = new.target.name;
    }
}

export class ConflictError extends AppError {
    constructor(message: string, options?: ErrorOptions) {
        super("conflict", message, options);
    }
}

export class AuthUnavailableError extends AppError {
    constructor(options?: ErrorOptions) {
        super(
            "auth_unavailable",
            "Authentication provider unavailable",
            options,
        );
    }
}
