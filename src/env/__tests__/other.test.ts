import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('env/other', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isDev', () => {
    it('true when NODE_ENV is development', async () => {
      process.env = { ...originalEnv, NODE_ENV: 'development' };
      const { isDev } = await import('../other');
      expect(isDev).toBe(true);
    });

    it('false when NODE_ENV is production', async () => {
      process.env = { ...originalEnv, NODE_ENV: 'production' };
      const { isDev } = await import('../other');
      expect(isDev).toBe(false);
    });
  });

  describe('isProd', () => {
    it('true when NODE_ENV is production', async () => {
      process.env = { ...originalEnv, NODE_ENV: 'production' };
      const { isProd } = await import('../other');
      expect(isProd).toBe(true);
    });

    it('false when NODE_ENV is development', async () => {
      process.env = { ...originalEnv, NODE_ENV: 'development' };
      const { isProd } = await import('../other');
      expect(isProd).toBe(false);
    });
  });

  describe('isTest', () => {
    it('true when NODE_ENV is test', async () => {
      process.env = { ...originalEnv, NODE_ENV: 'test' };
      const { isTest } = await import('../other');
      expect(isTest).toBe(true);
    });

    it('false when NODE_ENV is production', async () => {
      process.env = { ...originalEnv, NODE_ENV: 'production' };
      const { isTest } = await import('../other');
      expect(isTest).toBe(false);
    });
  });

  describe('isPreview', () => {
    it('true when IS_PREVIEW is "true"', async () => {
      process.env = { ...originalEnv, IS_PREVIEW: 'true' };
      const { isPreview } = await import('../other');
      expect(isPreview).toBe(true);
    });

    it('false when IS_PREVIEW is not set', async () => {
      const { IS_PREVIEW: _, ...envWithout } = originalEnv;
      process.env = envWithout;
      const { isPreview } = await import('../other');
      expect(isPreview).toBe(false);
    });

    it('false when IS_PREVIEW is not "true"', async () => {
      process.env = { ...originalEnv, IS_PREVIEW: 'false' };
      const { isPreview } = await import('../other');
      expect(isPreview).toBe(false);
    });
  });
});
