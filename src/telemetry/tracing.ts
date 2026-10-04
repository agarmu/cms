import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Attributes } from "@opentelemetry/api";
import { AppError } from "../lib/errors";

const tracer = trace.getTracer("photos-cms");

export function withSpan<T>(
    name: string,
    operation: () => Promise<T>,
    attributes: Attributes = {},
): Promise<T> {
    return tracer.startActiveSpan(name, { attributes }, async (span) => {
        try {
            return await operation();
        } catch (error) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.setAttribute(
                "error.type",
                error instanceof AppError
                    ? error.code
                    : error instanceof Error
                      ? error.name
                      : "unknown",
            );
            if (error instanceof Error) span.recordException(error);
            throw error;
        } finally {
            span.end();
        }
    });
}

export function traced(name: string, attributes: Attributes = {}) {
    return function <This, Args extends unknown[], Result>(
        method: (this: This, ...args: Args) => Promise<Result>,
        _context: ClassMethodDecoratorContext<
            This,
            (this: This, ...args: Args) => Promise<Result>
        >,
    ) {
        return function (this: This, ...args: Args): Promise<Result> {
            return withSpan(name, () => method.apply(this, args), attributes);
        };
    };
}
