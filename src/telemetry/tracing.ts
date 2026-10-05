import {
    context,
    ROOT_CONTEXT,
    SpanStatusCode,
    trace,
} from "@opentelemetry/api";
import type { Attributes, Span, SpanOptions } from "@opentelemetry/api";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { AppError } from "../lib/errors";

const tracer = trace.getTracer("photos-cms");

export function recordSpanError(
    error: unknown,
    span: Span | undefined = trace.getActiveSpan(),
) {
    if (!span) return;
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute(
        "error.type",
        error instanceof AppError
            ? error.code
            : error instanceof Error
              ? error.name
              : "unknown",
    );
    span.recordException(error instanceof Error ? error : String(error));
}

export function setSpanAttributes(attributes: Attributes) {
    trace.getActiveSpan()?.setAttributes(attributes);
}

export function withSpan<T>(
    name: string,
    operation: () => Promise<T>,
    attributes: Attributes = {},
    options: SpanOptions = {},
): Promise<T> {
    return tracer.startActiveSpan(
        name,
        { ...options, attributes },
        async (span) => {
            try {
                return await operation();
            } catch (error) {
                recordSpanError(error, span);
                throw error;
            } finally {
                span.end();
            }
        },
    );
}

export function withSyncSpan<T>(
    name: string,
    operation: () => T,
    attributes: Attributes = {},
): T {
    return tracer.startActiveSpan(name, { attributes }, (span) => {
        try {
            return operation();
        } catch (error) {
            recordSpanError(error, span);
            throw error;
        } finally {
            span.end();
        }
    });
}

// Timer callbacks must not inherit a request or an already-ended startup span.
export function withRootSpan<T>(
    name: string,
    operation: () => Promise<T>,
    attributes: Attributes = {},
): Promise<T> {
    return context.with(ROOT_CONTEXT, () =>
        withSpan(name, operation, attributes),
    );
}

// Keep the span open for the actual transfer, rather than just creating a stream.
export function tracedStream(
    name: string,
    source: () => ReadableStream<Uint8Array>,
    attributes: Attributes = {},
    options: SpanOptions = {},
) {
    const span = tracer.startSpan(name, { ...options, attributes });
    const active = trace.setSpan(context.active(), span);
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
        reader = context.with(active, () => source().getReader());
    } catch (error) {
        recordSpanError(error, span);
        span.end();
        throw error;
    }
    let bytes = 0;
    let ended = false;
    let cancelled = false;
    const finish = () => {
        if (ended) return;
        ended = true;
        span.setAttribute("storage.transfer.bytes", bytes);
        reader.releaseLock();
        span.end();
    };
    return new ReadableStream<Uint8Array>({
        pull: (controller) =>
            context.with(active, async () => {
                try {
                    const { done, value } = await reader.read();
                    if (cancelled) return;
                    if (done) {
                        controller.close();
                        finish();
                    } else {
                        bytes += value.byteLength;
                        controller.enqueue(value);
                    }
                } catch (error) {
                    recordSpanError(error, span);
                    controller.error(error);
                    finish();
                }
            }),
        cancel: (reason) =>
            context.with(active, async () => {
                cancelled = true;
                span.setAttribute("storage.transfer.cancelled", true);
                try {
                    await reader.cancel(reason);
                } catch (error) {
                    recordSpanError(error, span);
                    throw error;
                } finally {
                    finish();
                }
            }),
    });
}

export function traced(
    name: string,
    attributes: Attributes = {},
    options: SpanOptions = {},
) {
    return function <This, Args extends unknown[], Result>(
        method: (this: This, ...args: Args) => Promise<Result>,
        _context: ClassMethodDecoratorContext<
            This,
            (this: This, ...args: Args) => Promise<Result>
        >,
    ) {
        return function (this: This, ...args: Args): Promise<Result> {
            return withSpan(
                name,
                () => method.apply(this, args),
                attributes,
                options,
            );
        };
    };
}
