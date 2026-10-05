import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
    defaultResource,
    detectResources,
    envDetector,
    resourceFromAttributes,
} from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { BunSqlInstrumentation } from "@8monkey/opentelemetry-instrumentation-bun-sql";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { TelemetryConfiguration } from "./config";

export class Telemetry {
    private provider: NodeTracerProvider | undefined;
    private unregister: (() => void) | undefined;
    private stopping: Promise<void> | undefined;

    constructor(private readonly config = new TelemetryConfiguration()) {}

    start(exporter?: SpanExporter) {
        if (this.stopping) throw new Error("Telemetry has been stopped");
        if (!this.config.enabled) return undefined;
        if (this.provider) return this.provider;

        const provider = new NodeTracerProvider({
            resource: defaultResource()
                .merge(
                    resourceFromAttributes({
                        "service.name": this.config.serviceName,
                    }),
                )
                .merge(detectResources({ detectors: [envDetector] })),
            spanProcessors: [
                new BatchSpanProcessor(exporter ?? new OTLPTraceExporter()),
            ],
        });
        // Registers AsyncLocalStorage context and W3C tracecontext/baggage propagation.
        provider.register();
        this.unregister = registerInstrumentations({
            instrumentations: [new BunSqlInstrumentation()],
        });
        this.provider = provider;
        return provider;
    }

    stop() {
        return (this.stopping ??= (async () => {
            try {
                await this.provider?.shutdown();
            } finally {
                this.unregister?.();
            }
        })());
    }
}
