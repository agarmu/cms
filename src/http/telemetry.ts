import { Elysia } from "elysia";
import {
    context,
    metrics,
    propagation,
    SpanKind,
    SpanStatusCode,
    trace,
} from "@opentelemetry/api";
import { Tracing } from "../telemetry/tracing";

export class HttpTelemetry {
    private readonly routes = new WeakMap<Request, string>();
    readonly plugin = new Elysia({ name: "http-telemetry" })
        .wrap((handle, request) => async (...args: unknown[]) => {
            const duration = metrics
                .getMeter("photos-cms")
                .createHistogram("http.server.request.duration", { unit: "s" });
            const start = performance.now();
            return context.with(
                propagation.extract(
                    context.active(),
                    Object.fromEntries(request.headers),
                ),
                () =>
                    Tracing.withSpan(
                        "http.request",
                        async () => {
                            const response: unknown = await handle(...args);
                            if (!(response instanceof Response))
                                throw new Error(
                                    "HTTP handler returned no response",
                                );
                            const attributes = {
                                "http.request.method": request.method,
                                "http.response.status_code": response.status,
                                ...(this.routes.has(request)
                                    ? {
                                          "http.route":
                                              this.routes.get(request)!,
                                      }
                                    : {}),
                            };
                            const span = trace.getActiveSpan();
                            span?.setAttributes(attributes);
                            if (response.status >= 400)
                                span?.setStatus({ code: SpanStatusCode.ERROR });
                            duration.record(
                                (performance.now() - start) / 1000,
                                attributes,
                            );
                            return response;
                        },
                        {},
                        { kind: SpanKind.SERVER },
                    ),
            );
        })
        .onBeforeHandle(({ request, route }) => {
            this.routes.set(request, route);
            Tracing.setSpanAttributes({ "http.route": route });
        })
        .as("global");
}
