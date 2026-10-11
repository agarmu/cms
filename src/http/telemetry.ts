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
//
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
