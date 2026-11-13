import { describe, expect, it, vi } from 'vitest';
import { describeSubmitError } from './orchestrator-core';

// The client's dist imports a directory, which Node's ESM loader refuses; this file needs none of it.
vi.mock('@civitai/orchestration-client', () => ({}));

describe('describeSubmitError', () => {
  it('summarises an edge error page instead of returning its markup', () => {
    const page =
      '<!DOCTYPE html> <html lang="en"><head><title>We\'ll be right back | Civitai</title></head>' +
      '<body><div class="cf-error-details cf-error-502"><h1>Bad gateway</h1></div></body></html>';
    const message = describeSubmitError(page);
    expect(message).not.toContain('<');
    expect(message).toContain('HTTP 502');
  });

  it('keeps a plain-text error as-is', () => {
    expect(describeSubmitError('workflow not found')).toBe('workflow not found');
  });

  it('names the HTTP status of a failure with an empty body', () => {
    expect(describeSubmitError(undefined, 502)).toContain('HTTP 502');
    expect(describeSubmitError('', 503)).toContain('HTTP 503');
    expect(describeSubmitError({ detail: 'bad input' }, 400)).toBe('bad input');
  });
});
