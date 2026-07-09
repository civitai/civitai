import { describe, it, expect } from 'vitest';
import { resolveAuthGuard } from '../route-guard';

const mod = { user: { id: 5, isModerator: true } };
const regular = { user: { id: 5, isModerator: false } };
const anon = null;

const prod = { isProd: true, isPreview: false };
const preview = { isProd: false, isPreview: true };
const dev = { isProd: false, isPreview: false };

describe('resolveAuthGuard', () => {
  describe('/moderator', () => {
    it('sends an anon user to login (with returnUrl)', () => {
      expect(resolveAuthGuard('/moderator/reports', anon, prod)).toEqual({
        redirect: '/login?returnUrl=%2Fmoderator%2Freports',
      });
    });
    it('sends a logged-in non-moderator home (login would loop)', () => {
      expect(resolveAuthGuard('/moderator/reports', regular, prod)).toEqual({ redirect: '/' });
    });
    it('admits a moderator', () => {
      expect(resolveAuthGuard('/moderator/reports', mod, prod)).toBeNull();
    });
  });

  describe('/testing', () => {
    it('requires a moderator in prod', () => {
      expect(resolveAuthGuard('/testing/demo', regular, prod)).toEqual({ redirect: '/' });
      expect(resolveAuthGuard('/testing/demo', anon, prod)).toEqual({
        redirect: '/login?returnUrl=%2Ftesting%2Fdemo',
      });
    });
    it('is open to everyone outside prod', () => {
      expect(resolveAuthGuard('/testing/demo', regular, dev)).toBeNull();
      expect(resolveAuthGuard('/testing/demo', anon, dev)).toBeNull();
    });
  });

  describe('preview deploy', () => {
    it('sends an anon user to login', () => {
      expect(resolveAuthGuard('/models', anon, preview)).toEqual({
        redirect: '/login?returnUrl=%2Fmodels',
      });
    });
    it('admits a moderator without a Flipt check', () => {
      expect(resolveAuthGuard('/models', mod, preview)).toBeNull();
    });
    it('defers a logged-in non-moderator to the preview Flipt check', () => {
      expect(resolveAuthGuard('/models', regular, preview)).toEqual({ needsPreviewCheck: true });
    });
    it('never gates the login or preview-restricted pages', () => {
      expect(resolveAuthGuard('/login', anon, preview)).toBeNull();
      expect(resolveAuthGuard('/preview-restricted', anon, preview)).toBeNull();
    });
  });

  describe('normal pages', () => {
    it('allows any user (no guard match)', () => {
      expect(resolveAuthGuard('/models', regular, prod)).toBeNull();
      expect(resolveAuthGuard('/models', anon, prod)).toBeNull();
      expect(resolveAuthGuard('/', mod, prod)).toBeNull();
    });
  });
});
