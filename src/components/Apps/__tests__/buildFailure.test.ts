import { describe, expect, it } from 'vitest';

import {
  AUTHOR_FAILURE_GUIDANCE,
  describeBuildFailure,
  PLATFORM_FAILURE_GUIDANCE,
  SECURITY_SCAN_GUIDANCE,
  UNKNOWN_FAILURE_GUIDANCE,
} from '~/components/Apps/buildFailure';
import {
  DEPLOY_FAILURE_DETAIL,
  RETRIGGER_FAILED_AUTHOR_DETAIL,
} from '~/shared/constants/app-block-deploy.constants';

import {
  BUILD_NONE_DETAIL,
  DEPLOY_TIMED_OUT_DETAIL,
  HOSTILE_DETAIL,
  HOSTILE_EXCERPT,
  NPM_TAIL_DETAIL,
  NPM_TAIL_EXCERPT,
  RECIPE_ERROR_DETAIL,
  RECIPE_ERROR_EXCERPT,
  SCAN_BLOCKED_DETAIL,
  SCAN_BLOCKED_EXCERPT,
} from './buildFailureFixtures';

/**
 * `describeBuildFailure` — the one place a failed version's stored detail becomes author
 * copy. Fixtures other than `HOSTILE_*` are values the server writes (see
 * `buildFailureFixtures`), so these pin the mapping for the shapes production produces.
 */

/** Every string the author can read for one description. */
function rendered(d: ReturnType<typeof describeBuildFailure>): string {
  return [d.badge, d.headline, d.guidance, d.excerpt ?? ''].join('\n');
}

describe('the cause, from the stored detail', () => {
  it('a blocking scan finding (the incident shape) is a security-scan failure, not the author’s', () => {
    const d = describeBuildFailure(SCAN_BLOCKED_DETAIL);
    expect(d.failureClass).toBe('security-scan');
    expect(d.headline).toBe('Blocked by the security scan');
    expect(d.guidance).toBe(SECURITY_SCAN_GUIDANCE);
    expect(d.excerpt).toBe(SCAN_BLOCKED_EXCERPT);
  });

  it('a build pre-check ERROR line is the author’s to fix', () => {
    const d = describeBuildFailure(RECIPE_ERROR_DETAIL);
    expect(d.failureClass).toBe('author');
    expect(d.badge).toBe('build failed');
    expect(d.guidance).toBe(AUTHOR_FAILURE_GUIDANCE);
    expect(d.excerpt).toBe(RECIPE_ERROR_EXCERPT);
  });

  it('an ERROR line that is not the FIRST line does not make it the author’s', () => {
    // The pipeline puts the pre-check lines first when there are any; an ERROR buried in a
    // log tail is somebody else's output and proves nothing about who broke the build.
    const d = describeBuildFailure(`Build None\n\nsome tool output\nERROR: something`);
    expect(d.failureClass).toBe('unknown');
  });

  it('each deploy failure is the platform’s, with no excerpt to show', () => {
    for (const detail of Object.values(DEPLOY_FAILURE_DETAIL)) {
      const d = describeBuildFailure(detail);
      expect(d.failureClass, detail).toBe('platform');
      expect(d.badge, detail).toBe('deploy failed');
      expect(d.guidance, detail).toBe(PLATFORM_FAILURE_GUIDANCE);
      expect(d.excerpt, detail).toBeNull();
    }
    expect(describeBuildFailure(DEPLOY_TIMED_OUT_DETAIL).headline).toBe(
      'Your app built, but the deploy timed out'
    );
  });

  it('a failed moderator re-trigger is the platform’s', () => {
    const d = describeBuildFailure(RETRIGGER_FAILED_AUTHOR_DETAIL);
    expect(d.failureClass).toBe('platform');
    expect(d.guidance).toBe(PLATFORM_FAILURE_GUIDANCE);
    expect(d.excerpt).toBeNull();
  });
});

describe('🔴 the fallback is UNKNOWN, never the author', () => {
  it.each([
    ['Build None with no excerpt', BUILD_NONE_DETAIL, null],
    ['Build Failed with an unrecognised log tail', NPM_TAIL_DETAIL, NPM_TAIL_EXCERPT],
    ['a null detail (legacy row)', null, null],
    ['an empty detail', '   ', null],
  ])('%s → unknown', (_label, detail, excerpt) => {
    const d = describeBuildFailure(detail);
    expect(d.failureClass).toBe('unknown');
    expect(d.guidance).toBe(UNKNOWN_FAILURE_GUIDANCE);
    expect(d.guidance).toBe(
      "We couldn't determine the cause — retry, or contact us if it repeats."
    );
    expect(d.excerpt).toBe(excerpt);
  });

  it('a detail in no known shape is shown as-is, attributed to nobody', () => {
    const d = describeBuildFailure('something new went wrong');
    expect(d.failureClass).toBe('unknown');
    expect(d.excerpt).toBe('something new went wrong');
  });
});

describe('🔴 what the author is never told', () => {
  const ALL = [
    SCAN_BLOCKED_DETAIL,
    RECIPE_ERROR_DETAIL,
    BUILD_NONE_DETAIL,
    NPM_TAIL_DETAIL,
    HOSTILE_DETAIL,
    RETRIGGER_FAILED_AUTHOR_DETAIL,
    ...Object.values(DEPLOY_FAILURE_DETAIL),
    null,
  ];

  it('"Build None" never reaches the author, in any field', () => {
    for (const detail of ALL) {
      expect(rendered(describeBuildFailure(detail)), String(detail)).not.toMatch(/Build None/);
    }
  });

  it('only an author-class failure says to submit a new version', () => {
    for (const detail of ALL) {
      const d = describeBuildFailure(detail);
      const saysResubmit =
        /submit a new version/i.test(d.guidance) && !/don't need to/i.test(d.guidance);
      expect(saysResubmit, String(detail)).toBe(d.failureClass === 'author');
    }
  });

  it('no failure is blamed on "your code"', () => {
    for (const detail of ALL) {
      expect(rendered(describeBuildFailure(detail)), String(detail)).not.toMatch(/your code/i);
    }
  });
});

it('a hostile excerpt passes through unchanged — escaping is the renderer’s job', () => {
  expect(describeBuildFailure(HOSTILE_DETAIL).excerpt).toBe(HOSTILE_EXCERPT);
});
