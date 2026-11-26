import { describe, expect, it } from 'vitest';
import handler from '~/pages/api/v1/blocks/sdk-floor';

/**
 * GET /api/v1/blocks/sdk-floor — the floor `civitai app submit` reads before packaging. The CLI
 * parses this exact shape, so the body is pinned as a literal.
 */
function call(method: string) {
  let statusCode = 0;
  let payload: unknown;
  const headers: Record<string, string> = {};
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: unknown) {
      payload = body;
      return res;
    },
    setHeader(key: string, value: string) {
      headers[key] = value;
    },
  };
  handler({ method, headers: {} } as never, res as never);
  return { statusCode, payload, headers };
}

describe('GET /api/v1/blocks/sdk-floor', () => {
  it('publishes the minimum of @civitai/sdk and @civitai/blocks-react', () => {
    const { statusCode, payload, headers } = call('GET');
    expect(statusCode).toBe(200);
    expect(payload).toEqual({
      packages: [
        { name: '@civitai/sdk', minimum: '0.33.0' },
        { name: '@civitai/blocks-react', minimum: '0.87.0' },
      ],
    });
    expect(headers['Cache-Control']).toBe('public, max-age=300');
  });

  it('answers 405 to anything but GET', () => {
    const { statusCode, headers } = call('POST');
    expect(statusCode).toBe(405);
    expect(headers.Allow).toBe('GET');
  });
});
