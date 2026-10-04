import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
    defaultResource,
    detectResources,
    envDetector,
    resourceFromAttributes,
} from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

export function startTelemetry(exporter?: SpanExporter) {
    if (process.env["OTEL_SDK_DISABLED"]?.toLowerCase() === "true")
        return undefined;

    const provider = new NodeTracerProvider({
        resource: defaultResource()
            .merge(resourceFromAttributes({ "service.name": "photos-cms" }))
            .merge(detectResources({ detectors: [envDetector] })),
        spanProcessors: [
            new BatchSpanProcessor(exporter ?? new OTLPTraceExporter()),
        ],
    });
    // Registers AsyncLocalStorage context and W3C tracecontext/baggage propagation.
    provider.register();
    return provider;
}
