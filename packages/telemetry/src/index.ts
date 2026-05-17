/**
 * @sci/telemetry — shared OpenTelemetry SDK init
 *
 * No-op when OTEL_EXPORTER_OTLP_ENDPOINT is not set (safe for local dev).
 * Call startTelemetry() once at process startup BEFORE any other imports.
 *
 * Usage:
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://194.238.29.36:4318 \
 *   node dist/index.js
 */

import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { Resource } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { trace, metrics, SpanStatusCode } from '@opentelemetry/api'
import type { Span } from '@opentelemetry/api'

export { trace, metrics, SpanStatusCode }
export type { Span }

let _sdk: NodeSDK | null = null

export function startTelemetry(opts: { service: string; version?: string }): void {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
  if (!endpoint) {
    process.stderr.write(`[telemetry] OTEL_EXPORTER_OTLP_ENDPOINT not set — tracing disabled\n`)
    return
  }

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: opts.service,
    [ATTR_SERVICE_VERSION]: opts.version ?? '0.1.0',
    'deployment.environment': process.env['NODE_ENV'] ?? 'development',
  })

  const traceExporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })
  const metricExporter = new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` })

  _sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 15_000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Too noisy / high-cardinality for this workload
        '@opentelemetry/instrumentation-fs':  { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
    ],
  })

  _sdk.start()
  process.stderr.write(`[telemetry] OTel started → ${endpoint} (service=${opts.service})\n`)

  // Flush on shutdown
  const shutdown = () => _sdk?.shutdown().catch(() => {})
  process.on('SIGTERM', shutdown)
  process.on('SIGINT',  shutdown)
}

/** Tracer for a given instrumentation scope. */
export function getTracer(name: string) {
  return trace.getTracer(name)
}

/** Meter for a given instrumentation scope. */
export function getMeter(name: string) {
  return metrics.getMeter(name)
}

/**
 * Run `fn` inside a new active span.
 * - Sets OK status on success, ERROR on throw.
 * - Ends the span in both cases.
 * - Returns fn's value unchanged.
 */
export async function withSpan<T>(
  tracerName: string,
  spanName: string,
  attrs: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return getTracer(tracerName).startActiveSpan(spanName, async (span) => {
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v)
    try {
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
      span.recordException(err as Error)
      throw err
    } finally {
      span.end()
    }
  })
}
