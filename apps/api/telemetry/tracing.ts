// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

import {
    context,
    ROOT_CONTEXT,
    SpanStatusCode,
    trace,
} from "@opentelemetry/api";
import type { Attributes, Span, SpanOptions } from "@opentelemetry/api";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { AppError } from "../lib/errors";

export class Tracing {
    private static readonly tracer = trace.getTracer("photos-cms");

    static recordSpanError(
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

    static setSpanAttributes(attributes: Attributes) {
        trace.getActiveSpan()?.setAttributes(attributes);
    }

    static withSpan<T>(
        name: string,
        operation: () => Promise<T>,
        attributes: Attributes = {},
        options: SpanOptions = {},
    ): Promise<T> {
        return Tracing.tracer.startActiveSpan(
            name,
            { ...options, attributes },
            async (span) => {
                try {
                    return await operation();
                } catch (error) {
                    Tracing.recordSpanError(error, span);
                    throw error;
                } finally {
                    span.end();
                }
            },
        );
    }

    static withSyncSpan<T>(
        name: string,
        operation: () => T,
        attributes: Attributes = {},
    ): T {
        return Tracing.tracer.startActiveSpan(name, { attributes }, (span) => {
            try {
                return operation();
            } catch (error) {
                Tracing.recordSpanError(error, span);
                throw error;
            } finally {
                span.end();
            }
        });
    }

    // Timer callbacks must not inherit a request or an already-ended startup span.
    static withRootSpan<T>(
        name: string,
        operation: () => Promise<T>,
        attributes: Attributes = {},
    ): Promise<T> {
        return context.with(ROOT_CONTEXT, () =>
            Tracing.withSpan(name, operation, attributes),
        );
    }

    // Keep the span open for the actual transfer, rather than just creating a stream.
    static tracedStream(
        name: string,
        source: () => ReadableStream<Uint8Array>,
        attributes: Attributes = {},
        options: SpanOptions = {},
    ) {
        const span = Tracing.tracer.startSpan(name, { ...options, attributes });
        const active = trace.setSpan(context.active(), span);
        let reader: ReadableStreamDefaultReader<Uint8Array>;
        try {
            reader = context.with(active, () => source().getReader());
        } catch (error) {
            Tracing.recordSpanError(error, span);
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
                        Tracing.recordSpanError(error, span);
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
                        Tracing.recordSpanError(error, span);
                        throw error;
                    } finally {
                        finish();
                    }
                }),
        });
    }

    static traced(
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
                return Tracing.withSpan(
                    name,
                    () => method.apply(this, args),
                    attributes,
                    options,
                );
            };
        };
    }
}
