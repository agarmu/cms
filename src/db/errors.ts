export class DatabaseErrors {
    static constraintStatus(error: Error): 400 | 409 | undefined {
        const cause: unknown = error.cause ?? error;
        if (typeof cause !== "object" || cause === null) return undefined;
        const code =
            "errno" in cause && typeof cause.errno === "string"
                ? cause.errno
                : "code" in cause
                  ? cause.code
                  : undefined;
        if (code === "23503" || code === "23505") return 409;
        if (code === "23514" || code === "23502") return 400;
        return undefined;
    }
}
