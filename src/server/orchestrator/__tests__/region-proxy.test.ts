import { describe, expect, it } from 'vitest';
import {
  ORCHESTRATOR_PROXY_HOST,
  rewriteOrchestratorUrlToProxy,
  rewriteOrchestratorUrlsDeep,
} from '~/server/orchestrator/region-proxy';

describe('rewriteOrchestratorUrlToProxy', () => {
  it('swaps the orchestrator host and preserves path + presign query', () => {
    const url =
      'https://orchestration-new.civitai.com/v2/consumer/blobs/ABC123.jpeg?sig=CfDJ8abc&exp=2027-02-26T17:34:23Z';
    expect(rewriteOrchestratorUrlToProxy(url)).toBe(
      `https://${ORCHESTRATOR_PROXY_HOST}/v2/consumer/blobs/ABC123.jpeg?sig=CfDJ8abc&exp=2027-02-26T17:34:23Z`
    );
  });

  it('rewrites any orchestration* subdomain', () => {
    expect(
      rewriteOrchestratorUrlToProxy('https://orchestration.civitai.com/v2/consumer/blobs/x.mp4')
    ).toBe(`https://${ORCHESTRATOR_PROXY_HOST}/v2/consumer/blobs/x.mp4`);
  });

  it('leaves the proxy host untouched (no double-rewrite)', () => {
    const url = `https://${ORCHESTRATOR_PROXY_HOST}/v2/consumer/blobs/x.jpeg`;
    expect(rewriteOrchestratorUrlToProxy(url)).toBe(url);
  });

  it('ignores non-orchestrator URLs', () => {
    const url = 'https://image.civitai.com/xyz/width=450/x.jpeg';
    expect(rewriteOrchestratorUrlToProxy(url)).toBe(url);
  });

  it('returns malformed input unchanged', () => {
    expect(rewriteOrchestratorUrlToProxy('not a url')).toBe('not a url');
  });
});

describe('rewriteOrchestratorUrlsDeep', () => {
  it('rewrites orchestrator URLs nested in arrays and objects, in place', () => {
    const payload = {
      items: [
        {
          url: 'https://orchestration-new.civitai.com/v2/consumer/blobs/a.jpeg?sig=1',
          thumbnailUrl: 'https://orchestration-new.civitai.com/v2/consumer/blobs/thumb.jpeg?sig=2',
          nsfwLevel: 4,
          cdn: 'https://image.civitai.com/keep.jpeg',
        },
      ],
      video: 'https://orchestration-new.civitai.com/v2/consumer/blobs/v.mp4?sig=3',
    };
    const returned = rewriteOrchestratorUrlsDeep(payload);
    expect(returned).toBe(payload);
    expect(payload.items[0].url).toBe(
      `https://${ORCHESTRATOR_PROXY_HOST}/v2/consumer/blobs/a.jpeg?sig=1`
    );
    expect(payload.items[0].thumbnailUrl).toBe(
      `https://${ORCHESTRATOR_PROXY_HOST}/v2/consumer/blobs/thumb.jpeg?sig=2`
    );
    expect(payload.items[0].nsfwLevel).toBe(4);
    expect(payload.items[0].cdn).toBe('https://image.civitai.com/keep.jpeg');
    expect(payload.video).toBe(`https://${ORCHESTRATOR_PROXY_HOST}/v2/consumer/blobs/v.mp4?sig=3`);
  });

  it('rewrites a bare top-level string payload', () => {
    expect(
      rewriteOrchestratorUrlsDeep(
        'https://orchestration-new.civitai.com/v2/consumer/blobs/a.jpeg?sig=1'
      )
    ).toBe(`https://${ORCHESTRATOR_PROXY_HOST}/v2/consumer/blobs/a.jpeg?sig=1`);
  });

  it('leaves primitives and null untouched', () => {
    expect(rewriteOrchestratorUrlsDeep(null)).toBe(null);
    expect(rewriteOrchestratorUrlsDeep(42)).toBe(42);
    expect(rewriteOrchestratorUrlsDeep(undefined)).toBe(undefined);
  });
});
