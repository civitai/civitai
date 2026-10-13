import { describe, expect, it } from 'vitest';
import { movedViewTarget, redirectWithoutParam } from '$lib/moved-pages';

const at = (path: string) => new URL(`https://moderator.example${path}`);

describe('redirectWithoutParam', () => {
  it('drops the selector and keeps every other param', () => {
    expect(
      redirectWithoutParam(at('/x?type=scam&status=any&q=bob&selected=12'), 'type', '/y')
    ).toBe('/y?status=any&q=bob&selected=12');
  });

  it('has no query string when nothing else is left', () => {
    expect(redirectWithoutParam(at('/x?type=scam'), 'type', '/y')).toBe('/y');
  });
});

describe('movedViewTarget', () => {
  it('sends the old scam view to Users', () => {
    expect(movedViewTarget(at('/audit/generator-restrictions?type=scam&page=2'))).toBe(
      '/users/scam-restrictions?page=2'
    );
  });

  it('sends the old appeals tab to Model Flag Appeals', () => {
    expect(movedViewTarget(at('/models/minor-hash-matches?tab=appeals&q=bob&page=2'))).toBe(
      '/models/flag-appeals?q=bob&page=2'
    );
  });

  it.each([
    '/audit/generator-restrictions',
    '/audit/generator-restrictions?type=bot-account',
    '/models/minor-hash-matches?tab=auto',
    '/users/scam-restrictions?type=scam',
    '/images?type=scam',
  ])('leaves %s alone', (path) => {
    expect(movedViewTarget(at(path))).toBeNull();
  });
});
