import { describe, it, expect } from 'vitest';
import { extractStepErrors, sanitizeProviderError } from '../provider-errors';

describe('sanitizeProviderError', () => {
  it('passes a plain message through, prefixed with the provider name', () => {
    expect(sanitizeProviderError('GPU out of memory', 'grok')).toBe(
      'xAI (Grok): GPU out of memory'
    );
    expect(sanitizeProviderError('Rate limit exceeded', 'fal')).toBe('Fal.ai: Rate limit exceeded');
    expect(sanitizeProviderError('Model is warming up', 'flux2')).toBe(
      'Fal.ai (Flux): Model is warming up'
    );
  });

  it('does not double-brand when the provider is already mentioned', () => {
    expect(sanitizeProviderError('xAI (Grok) is temporarily overloaded', 'grok')).toBe(
      'xAI (Grok) is temporarily overloaded'
    );
  });

  it('returns the raw message unprefixed when the engine is unknown/missing', () => {
    expect(sanitizeProviderError('Content violates the provider policy')).toBe(
      'Content violates the provider policy'
    );
    expect(sanitizeProviderError('Content violates the provider policy', 'made-up-engine')).toBe(
      'Content violates the provider policy'
    );
  });

  // Guards against the over-redaction that a naive denylist causes — these are exactly
  // the useful provider errors the feature exists to surface.
  it('does NOT redact prose containing the word "at"', () => {
    expect(sanitizeProviderError('Service is overloaded, try again at a later time', 'grok')).toBe(
      'xAI (Grok): Service is overloaded, try again at a later time'
    );
    expect(sanitizeProviderError('Request was blocked at moderation', 'grok')).toBe(
      'xAI (Grok): Request was blocked at moderation'
    );
  });

  it('does NOT redact LLM token-limit errors', () => {
    expect(sanitizeProviderError('Maximum context tokens exceeded', 'grok')).toBe(
      'xAI (Grok): Maximum context tokens exceeded'
    );
  });

  it('redacts stack traces and filesystem paths to a generic message', () => {
    expect(
      sanitizeProviderError(
        'Error at Object.gen (/home/user/app/node_modules/sdk/index.js:52)',
        'grok'
      )
    ).toBe('xAI (Grok) reported a system error. Please try again.');
    expect(sanitizeProviderError('Cannot read file /app/src/worker/run.py', 'fal')).toBe(
      'Fal.ai reported a system error. Please try again.'
    );
  });

  it('redacts URLs, DB/infra errors, and credentials', () => {
    expect(sanitizeProviderError('Fetch failed: https://internal.civitai.io/v1/x', 'grok')).toBe(
      'xAI (Grok) reported a system error. Please try again.'
    );
    expect(
      sanitizeProviderError("PrismaClientInitializationError: can't reach database server", 'grok')
    ).toBe('xAI (Grok) reported a system error. Please try again.');
    expect(sanitizeProviderError('connect ECONNREFUSED 127.0.0.1:5432', 'fal')).toBe(
      'Fal.ai reported a system error. Please try again.'
    );
    expect(sanitizeProviderError('Invalid API Key: sk_live_deadbeef', 'openai')).toBe(
      'OpenAI reported a system error. Please try again.'
    );
  });

  it('redacts multi-line dumps and over-long messages', () => {
    expect(sanitizeProviderError('Traceback (most recent call last):\n  File ...', 'grok')).toBe(
      'xAI (Grok) reported a system error. Please try again.'
    );
    expect(sanitizeProviderError('x'.repeat(400), 'grok')).toBe(
      'xAI (Grok) reported a system error. Please try again.'
    );
  });
});

describe('extractStepErrors', () => {
  it('reads external-provider failures from failed job.reason (the previously-dropped path)', () => {
    const step = {
      output: {},
      jobs: [
        { status: 'succeeded' },
        { status: 'failed', reason: 'Provider returned 429: rate limited' },
      ],
    };
    expect(extractStepErrors(step)).toEqual(['Provider returned 429: rate limited']);
  });

  it('reads step.output.errors and the externalTOSViolation message', () => {
    const step = {
      output: { errors: ['boom'], externalTOSViolation: true, message: 'blocked by policy' },
    };
    expect(extractStepErrors(step).sort()).toEqual(['blocked by policy', 'boom']);
  });

  it('reads step.metadata.error and dedupes across sources', () => {
    const step = {
      output: { errors: ['same'] },
      jobs: [{ status: 'failed', reason: 'same' }],
      metadata: { error: 'meta boom' },
    };
    expect(extractStepErrors(step).sort()).toEqual(['meta boom', 'same']);
  });

  it('ignores non-failed jobs and returns [] for empty/nullish steps', () => {
    expect(extractStepErrors({ jobs: [{ status: 'succeeded', reason: 'ignore me' }] })).toEqual([]);
    expect(extractStepErrors(null)).toEqual([]);
    expect(extractStepErrors(undefined)).toEqual([]);
  });
});
