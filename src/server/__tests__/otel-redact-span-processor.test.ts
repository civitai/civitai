import { describe, expect, it } from 'vitest';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { CredentialRedactingSpanProcessor } from '~/server/otel-redact-span-processor';

const FAKE_KEY = 'fakekey0123456789abcdef0123456789';

describe('CredentialRedactingSpanProcessor', () => {
  it('exports request spans with credentials blanked and other query params intact', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new CredentialRedactingSpanProcessor(new SimpleSpanProcessor(exporter))],
    });
    const span = provider.getTracer('test').startSpan('GET');
    span.setAttributes({
      'http.target': `/api/download/models/1?token=${FAKE_KEY}&type=Model`,
      'url.full': `https://civitai.com/api/v1/images?page=2&apiKey=${FAKE_KEY}`,
      'url.query': `token=${FAKE_KEY}&page=2`,
      'http.query': 'page=2&limit=10',
      'http.status_code': 200,
    });
    span.end();
    await provider.forceFlush();

    const [exported] = exporter.getFinishedSpans();
    expect(JSON.stringify(exported.attributes)).not.toContain(FAKE_KEY);
    expect(exported.attributes).toMatchObject({
      'http.target': '/api/download/models/1?token=[redacted]&type=Model',
      'url.full': 'https://civitai.com/api/v1/images?page=2&apiKey=[redacted]',
      'url.query': 'token=[redacted]&page=2',
      'http.query': 'page=2&limit=10',
      'http.status_code': 200,
    });
  });
});
