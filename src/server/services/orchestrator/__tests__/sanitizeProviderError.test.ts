import { describe, it, expect } from 'vitest';
import { sanitizeProviderError } from '../common';

describe('sanitizeProviderError', () => {
  it('passes simple safe messages through unmodified when provider is in the message', () => {
    expect(sanitizeProviderError('xAI (Grok) is temporarily overloaded', 'grok')).toBe(
      'xAI (Grok) is temporarily overloaded'
    );
  });

  it('prepends the correct provider name when not in the message', () => {
    expect(sanitizeProviderError('GPU out of memory', 'grok')).toBe(
      'xAI (Grok) Error: GPU out of memory'
    );
    expect(sanitizeProviderError('API call rate limit exceeded', 'fal')).toBe(
      'Fal.ai Error: API call rate limit exceeded'
    );
    expect(sanitizeProviderError('GPU out of memory', 'flux2')).toBe(
      'Fal.ai (Flux) Error: GPU out of memory'
    );
  });

  it('replaces database and internal error keywords with a safe generic message', () => {
    expect(sanitizeProviderError('PrismaClientInitializationError: Can\'t reach database server', 'grok')).toBe(
      'The generation provider xAI (Grok) experienced a system error. Please try again.'
    );
    expect(sanitizeProviderError('connect ECONNREFUSED 127.0.0.1:5432', 'fal')).toBe(
      'The generation provider Fal.ai experienced a system error. Please try again.'
    );
    expect(sanitizeProviderError('Internal Server Error: sql execution timeout', 'grok')).toBe(
      'The generation provider xAI (Grok) experienced a system error. Please try again.'
    );
  });

  it('filters out bearer tokens or API key leaks', () => {
    expect(sanitizeProviderError('Invalid API Key: secret_token_12345', 'openai')).toBe(
      'The generation provider OpenAI experienced a system error. Please try again.'
    );
  });

  it('filters out filesystem paths or stack traces', () => {
    expect(
      sanitizeProviderError(
        'Error at /home/user/app/node_modules/grok-sdk/index.js:52',
        'grok'
      )
    ).toBe('The generation provider xAI (Grok) experienced a system error. Please try again.');
  });

  it('handles undefined or unrecognized engine gracefully', () => {
    expect(sanitizeProviderError('GPU out of memory')).toBe(
      'external provider Error: GPU out of memory'
    );
    expect(sanitizeProviderError('PrismaClientInitializationError: Can\'t reach database server')).toBe(
      'The generation provider external provider experienced a system error. Please try again.'
    );
  });
});
