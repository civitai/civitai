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

  it('sends the old re-detected view to Minor Detections, carrying the selection', () => {
    expect(movedViewTarget(at('/models/flag-appeals?view=redetected&item=7:minor&flag=poi'))).toBe(
      '/models/minor-detections?item=7%3Aminor&flag=poi'
    );
    expect(movedViewTarget(at('/models/flag-appeals?view=redetected'))).toBe(
      '/models/minor-detections'
    );
  });

  it.each([
    '/models/flag-appeals',
    '/models/flag-appeals?view=appeals',
    '/audit/generator-restrictions',
    '/audit/generator-restrictions?type=bot-account',
    '/models/minor-hash-matches?tab=auto',
    '/users/scam-restrictions?type=scam',
    '/images?type=scam',
  ])('leaves %s alone', (path) => {
    expect(movedViewTarget(at(path))).toBeNull();
  });

  // Answered in the request hook, before the grant check: the old path's group (Retool, Images) no
  // longer holds these pages, and a moderator with nothing in it was bounced to the dashboard.
  it('moves ?user= and ?tab= into the User Reports path, keeping the rest', () => {
    expect(movedViewTarget(at('/retool/user-reports?user=5&tab=images&page=2&tos=1'))).toBe(
      '/reports/user/5/images?page=2&tos=1'
    );
    expect(movedViewTarget(at('/retool/user-reports?user=5&tab=history'))).toBe('/reports/user/5');
    expect(movedViewTarget(at('/retool/user-reports?status=Pending'))).toBe(
      '/reports/user?status=Pending'
    );
  });

  it('moves ?post= into the Post Reports path, keeping the rest', () => {
    expect(movedViewTarget(at('/retool/post-reports?post=12&page=2&status=Pending'))).toBe(
      '/reports/post/12?page=2&status=Pending'
    );
    expect(movedViewTarget(at('/retool/post-reports'))).toBe('/reports/post');
  });

  it('sends the reported-image grid to /reports/image with its query', () => {
    expect(movedViewTarget(at('/images/reported?level=3&cursor=9'))).toBe(
      '/reports/image?level=3&cursor=9'
    );
    expect(movedViewTarget(at('/images/minor'))).toBeNull();
  });
});
