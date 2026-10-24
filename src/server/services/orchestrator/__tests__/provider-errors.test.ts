import { describe, it, expect } from 'vitest';
import {
  extractStepErrors,
  providerName,
  sanitizeProviderError,
  sanitizeStepErrors,
} from '../provider-errors';

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

describe('sanitizeStepErrors', () => {
  const refusal =
    "The request failed because the input image 'content[1]' may contain real person. Request id: 0123456789abcdef";

  it('shows a provider content refusal instead of a generic system error', () => {
    const step = { output: { externalTOSViolation: true, message: refusal } };
    expect(sanitizeStepErrors(step, 'seedance')).toEqual([
      'Seedance: The request failed because the input image may contain real person. Request id: 0123456789abcdef',
    ]);
  });

  it('still sanitises a refusal that carries unsafe content beyond the index token', () => {
    const step = {
      output: { externalTOSViolation: true, message: "Blocked 'content[1]' at https://internal/x" },
    };
    expect(sanitizeStepErrors(step, 'seedance')).toEqual([
      'Seedance reported a system error. Please try again.',
    ]);
  });

  // Control: the index-token normalisation is only for externalTOSViolation messages.
  it('still sanitises a non-refusal message that contains brackets', () => {
    const msg = "The request failed because the input image 'content[1]' may contain real person.";
    expect(sanitizeStepErrors({ output: { errors: [msg] } }, 'seedance')).toEqual([
      'Seedance reported a system error. Please try again.',
    ]);
    expect(sanitizeStepErrors({ metadata: { error: msg } }, 'seedance')).toEqual([
      'Seedance reported a system error. Please try again.',
    ]);
  });
});

describe('sanitizeStepErrors on a Flux 3 Video provider refusal', () => {
  const HINT = 'If your source image is rated above PG-13, try MiniMax H3 instead.';
  // A failed videoGen step as the workflow read returns it.
  const videoStep = (
    engine: string,
    output: Record<string, unknown>,
    operation = 'imageToVideo'
  ) => ({
    $type: 'videoGen',
    name: '0',
    status: 'failed',
    input: { engine, version: 'v3.0', operation, prompt: 'x' },
    output,
  });

  it("keeps the provider's refusal and adds the H3 hint", () => {
    const step = videoStep('flux', {
      externalTOSViolation: true,
      message: 'Request rejected by content moderation.',
    });
    expect(sanitizeStepErrors(step, 'flux')).toEqual([
      `Request rejected by content moderation. ${HINT}`,
    ]);
  });

  it('says the content filter refused when the provider gave no text', () => {
    const step = videoStep('flux', { externalTOSViolation: true, message: null });
    expect(sanitizeStepErrors(step, 'flux')).toEqual([
      `The provider's content filter rejected this request. ${HINT}`,
    ]);
  });

  it('does not pair the hint with a system error when the refusal is unsafe to show', () => {
    const step = videoStep('flux', {
      externalTOSViolation: true,
      message: 'Rejected, see https://internal.example/moderation',
    });
    expect(sanitizeStepErrors(step, 'flux')).toEqual([
      `The provider's content filter rejected this request. ${HINT}`,
    ]);
  });

  it('adds nothing to a generic Flux 3 failure', () => {
    const step = videoStep('flux', {
      errors: ['Timed out waiting for the provider'],
      message: null,
    });
    expect(sanitizeStepErrors(step, 'flux')).toEqual(['Timed out waiting for the provider']);
  });

  it('adds nothing to a text to video refusal, which had no source image', () => {
    const step = videoStep(
      'flux',
      { externalTOSViolation: true, message: 'Request rejected by content moderation.' },
      'textToVideo'
    );
    expect(sanitizeStepErrors(step, 'flux')).toEqual(['Request rejected by content moderation.']);
  });

  it('does not point an H3 refusal at H3', () => {
    const step = videoStep('minimax', {
      externalTOSViolation: true,
      message: 'Request rejected by content moderation.',
    });
    expect(sanitizeStepErrors(step, 'minimax')).toEqual([
      'Minimax: Request rejected by content moderation.',
    ]);
  });
});

describe('providerName', () => {
  it('names seedance', () => {
    expect(providerName('seedance')).toBe('Seedance');
  });
});

describe('extractStepErrors', () => {
  it('reads step.output.errors and the externalTOSViolation message', () => {
    const step = {
      output: { errors: ['boom'], externalTOSViolation: true, message: 'blocked by policy' },
    };
    expect(extractStepErrors(step).sort()).toEqual(['blocked by policy', 'boom']);
  });

  it('reads step.metadata.error and .errors, and dedupes across sources', () => {
    const step = {
      output: { errors: ['same'] },
      metadata: { error: 'meta boom', errors: ['same', 'meta list'] },
    };
    expect(extractStepErrors(step).sort()).toEqual(['meta boom', 'meta list', 'same']);
  });

  it('returns [] for empty/nullish steps', () => {
    expect(extractStepErrors({})).toEqual([]);
    expect(extractStepErrors(null)).toEqual([]);
    expect(extractStepErrors(undefined)).toEqual([]);
  });
});
