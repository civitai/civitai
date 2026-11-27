import { describe, expect, it } from 'vitest';
import { PLATFORM_SDK_FLOORS } from '@civitai/app-assistant/sdk-floor';
import handler from '~/pages/api/v1/blocks/sdk-floor';

/**
 * GET /api/v1/blocks/sdk-floor — the floor `civitai app submit` reads before packaging. The CLI
 * parses this exact shape, so the shape and the package names are pinned; the minimums are
 * whatever `PLATFORM_SDK_FLOORS` publishes, so raising a floor does not edit this test.
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
    // Exactly `{ packages: [{ name, minimum }] }`: no other key at either level.
    expect(Object.keys(payload as object)).toEqual(['packages']);
    const packages = (payload as { packages: Record<string, unknown>[] }).packages;
    for (const p of packages) {
      expect(Object.keys(p).sort()).toEqual(['minimum', 'name']);
      expect(p.minimum).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(packages.map((p) => p.name)).toEqual(['@civitai/sdk', '@civitai/blocks-react']);
    expect(packages).toEqual(PLATFORM_SDK_FLOORS.map(({ name, minimum }) => ({ name, minimum })));
    expect(headers['Cache-Control']).toBe('public, max-age=300');
  });

  it('answers 405 to anything but GET', () => {
    const { statusCode, headers } = call('POST');
    expect(statusCode).toBe(405);
    expect(headers.Allow).toBe('GET');
  });
});
