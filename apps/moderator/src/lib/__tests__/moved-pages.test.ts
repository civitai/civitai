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

  it('sends the old appeals tab to the Appeals tab', () => {
    expect(movedViewTarget(at('/models/minor-hash-matches?tab=appeals&q=bob&page=2'))).toBe(
      '/models/flags/appeals?q=bob&page=2'
    );
  });

  it('sends Minor Hash Matches to Needs review filtered to hash, and its auto tab to Auto-flagged', () => {
    expect(movedViewTarget(at('/models/minor-hash-matches'))).toBe(
      '/models/flags/needs-review?source=hash'
    );
    expect(movedViewTarget(at('/models/minor-hash-matches?tab=pending&q=bob'))).toBe(
      '/models/flags/needs-review?q=bob&source=hash'
    );
    expect(movedViewTarget(at('/models/minor-hash-matches?tab=auto&page=2'))).toBe(
      '/models/flags/auto?page=2&source=hash'
    );
  });

  it('sends Model Flag Appeals to Appeals, and its re-detected view to Needs review, carrying the selection', () => {
    expect(movedViewTarget(at('/models/flag-appeals?q=bob'))).toBe('/models/flags/appeals?q=bob');
    expect(movedViewTarget(at('/models/flag-appeals?view=appeals&appeal=7'))).toBe(
      '/models/flags/appeals?appeal=7'
    );
    expect(movedViewTarget(at('/models/flag-appeals?view=redetected&item=7:minor&flag=poi'))).toBe(
      '/models/flags/needs-review?item=7%3Aminor&flag=poi&source=text-scan'
    );
    expect(movedViewTarget(at('/models/flag-appeals?view=redetected'))).toBe(
      '/models/flags/needs-review?source=text-scan'
    );
  });

  it('sends Held Detections to Needs review filtered to text scan', () => {
    expect(movedViewTarget(at('/models/held-detections'))).toBe(
      '/models/flags/needs-review?source=text-scan'
    );
    expect(movedViewTarget(at('/models/held-detections?item=7:minor&flag=poi'))).toBe(
      '/models/flags/needs-review?item=7%3Aminor&flag=poi&source=text-scan'
    );
  });

  it('sends the old Flagged tab to Auto-flagged, and its re-detections to Needs review', () => {
    expect(movedViewTarget(at('/models/flags/review'))).toBe('/models/flags/auto');
    expect(movedViewTarget(at('/models/flags/review?source=hash&item=7&q=bob'))).toBe(
      '/models/flags/auto?source=hash&item=7&q=bob'
    );
    expect(movedViewTarget(at('/models/flags/review?source=text-scan&sort=newest'))).toBe(
      '/models/flags/auto?source=text-scan&sort=newest'
    );
    expect(movedViewTarget(at('/models/flags/review?source=redetected&item=7&flag=poi'))).toBe(
      '/models/flags/needs-review?source=text-scan&item=7&flag=poi'
    );
  });

  it('sends the old File matches tab to Needs review filtered to hash', () => {
    expect(movedViewTarget(at('/models/flags/matches'))).toBe(
      '/models/flags/needs-review?source=hash'
    );
    expect(movedViewTarget(at('/models/flags/matches?q=bob&item=11'))).toBe(
      '/models/flags/needs-review?q=bob&item=11&source=hash'
    );
  });

  it.each([
    '/models/flags/appeals',
    '/models/flags/auto?source=hash',
    '/models/flags/needs-review?source=hash',
    '/audit/generator-restrictions',
    '/audit/generator-restrictions?type=bot-account',
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
