import { metrics } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import {
    defaultResource,
    resourceFromAttributes,
} from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
    MeterProvider,
    PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
    BatchLogRecordProcessor,
    LoggerProvider,
} from "@opentelemetry/sdk-logs";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { BunSqlInstrumentation } from "@8monkey/opentelemetry-instrumentation-bun-sql";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { TelemetryConfiguration } from "./config";

// OTLP merges environment headers even when explicit headers are supplied.
// Constructors read them synchronously; restore the environment before async work.
function withFileConfiguration<T>(create: () => T): T {
    const environment = Object.entries(process.env).filter(([key]) =>
        key.startsWith("OTEL_"),
    );
    try {
        for (const [key] of environment) delete process.env[key];
        return create();
    } finally {
        for (const [key, value] of environment)
            if (value !== undefined) process.env[key] = value;
    }
}

export class Telemetry {
    private provider: NodeTracerProvider | undefined;
    private meterProvider: MeterProvider | undefined;
    private loggerProvider: LoggerProvider | undefined;
    private unregister: (() => void) | undefined;
    private stopping: Promise<void> | undefined;
    private started = false;

    constructor(private readonly config = new TelemetryConfiguration()) {}

    start(exporter?: SpanExporter) {
        if (this.stopping) throw new Error("Telemetry has been stopped");
        if (this.started || !this.config.enabled) return this.provider;
        this.started = true;
        return withFileConfiguration(() => {
            const resource = defaultResource().merge(
                resourceFromAttributes({
                    "service.name": this.config.serviceName,
                }),
            );
            if (this.config.metrics.enabled) {
                this.meterProvider = new MeterProvider({
                    resource,
                    readers: [
                        new PeriodicExportingMetricReader({
                            exporter: new OTLPMetricExporter({
                                url: this.config.metrics.endpoint!,
                                headers: this.config.metrics.headers,
                            }),
                        }),
                    ],
                });
                metrics.setGlobalMeterProvider(this.meterProvider);
            }
            if (this.config.logs.enabled) {
                this.loggerProvider = new LoggerProvider({
                    resource,
                    processors: [
                        new BatchLogRecordProcessor({
                            exporter: new OTLPLogExporter({
                                url: this.config.logs.endpoint!,
                                headers: this.config.logs.headers,
                            }),
                        }),
                    ],
                });
            }
            if (this.config.traces.enabled || exporter) {
                this.provider = new NodeTracerProvider({
                    resource,
                    spanProcessors: [
                        new BatchSpanProcessor(
                            exporter ??
                                new OTLPTraceExporter({
                                    url: this.config.traces.endpoint!,
                                    headers: this.config.traces.headers,
                                }),
                        ),
                    ],
                });
                // Registers AsyncLocalStorage context and W3C propagation before driver imports.
                this.provider.register();
                this.unregister = registerInstrumentations({
                    instrumentations: [new BunSqlInstrumentation()],
                });
            }
            return this.provider;
        });
    }

    log(body: string, severity: "INFO" | "ERROR" = "INFO") {
        this.loggerProvider?.getLogger("photos-cms").emit({
            body,
            severityText: severity,
            severityNumber:
                severity === "ERROR"
                    ? SeverityNumber.ERROR
                    : SeverityNumber.INFO,
        });
    }

    async forceFlush() {
        await this.settle([
            this.provider?.forceFlush(),
            this.meterProvider?.forceFlush(),
            this.loggerProvider?.forceFlush(),
        ]);
    }

    stop() {
        return (this.stopping ??= (async () => {
            try {
                await this.settle([
                    this.provider?.shutdown(),
                    this.meterProvider?.shutdown(),
                    this.loggerProvider?.shutdown(),
                ]);
            } finally {
                this.unregister?.();
            }
        })());
    }

    private async settle(operations: (Promise<void> | undefined)[]) {
        const results = await Promise.allSettled(operations);
        const errors = results
            .filter((result) => result.status === "rejected")
            .map((result) => result.reason);
        if (errors.length)
            throw new AggregateError(errors, "Telemetry export failed");
    }
}
