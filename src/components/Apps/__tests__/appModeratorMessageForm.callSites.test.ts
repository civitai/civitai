import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  MOD_MESSAGE_BODY_MAX,
  MOD_MESSAGE_BODY_MIN,
  MOD_MESSAGE_SUBJECT_MAX,
  MOD_MESSAGE_SUBJECT_MIN,
} from '~/server/schema/blocks/app-moderator-message.schema';

/**
 * 🔒 THE CALL-SITE LEDGER for the moderator → app-developer message surface.
 *
 * WHY THIS FILE EXISTS. `appListings.messageAppOwner` shipped complete — service,
 * audit event, rate limits, notification type, migration — and then sat in production
 * with ZERO UI callers, because nothing anywhere asserted that a caller existed. A
 * ledger is the cheap, mechanical version of the review that did not happen: it fails
 * when the set of mounting sites SHRINKS (the surface goes dark again) and when it
 * GROWS (a second surface appears that nobody wired to the same rules).
 *
 * It also pins the BOUNDS SINGLE-SOURCE. The composer's floors and ceilings belong to
 * `messageAppOwnerSchema`; a hand-typed copy in the component drifts silently and then
 * either offers a moderator a field they can fill and can never send, or blocks a
 * message the server would have accepted.
 *
 * 🔴 A STRUCTURAL CHECK IS NOT A BEHAVIOURAL ONE. That the modal is mounted says
 * nothing about whether the gate works — that is
 * `__tests__/appModeratorMessageForm.test.ts` (blocking) and
 * `MessageAppOwnerModal.browser.test.tsx` (report-only in CI).
 *
 * 🔴 KNOWN LIMITS, stated rather than implied. Detection is syntactic and per-file: a
 * site that mounts the modal through a wrapper or `React.createElement` is invisible
 * here. The numeric-literal scan strips comments with a regex, so a `//` sequence
 * inside a string literal in one of the scanned files would confuse it — neither
 * scanned file contains one today, and the positive control below proves the detector
 * can still fire when it matters.
 */

const SRC = path.resolve(__dirname, '../../..');

const FORM_MODULE = 'components/Apps/appModeratorMessageForm.ts';
const MODAL_MODULE = 'components/Apps/MessageAppOwnerModal.tsx';

/**
 * Every PRODUCTION site that mounts `MessageAppOwnerModal`. One today: the /apps/review
 * "Manage listings" table, which is the only moderator surface that holds an
 * `AppListing` id for an arbitrary listing in any status. Adding a second surface means
 * adding it here — that is the point, not an inconvenience.
 */
const MOUNT_SITES = ['components/Apps/AppListingsModerationTable.tsx'] as const;

const SCHEMA_IMPORT = '~/server/schema/blocks/app-moderator-message.schema';

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/** Strip `/* *\/` and `//` comments so prose that MENTIONS a bound is not a hit. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Standalone occurrences of `value` as a numeric token (not part of an identifier). */
function bareNumericHits(source: string, value: number): number {
  const re = new RegExp(`(?<![\\w.$])${value}(?![\\w.$])`, 'g');
  return (source.match(re) ?? []).length;
}

/**
 * Every production `.ts`/`.tsx` under `src/components` and `src/pages`, test files
 * excluded. Both trees are walked because a moderator surface can be a page as easily
 * as a component, and a mount added to a page would otherwise be invisible to the
 * ledger.
 */
function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.(test|browser\.test|spec)\.tsx?$/.test(entry.name)) continue;
      out.push(path.relative(SRC, full));
    }
  };
  walk(path.join(SRC, 'components'));
  walk(path.join(SRC, 'pages'));
  return out;
}

describe('the owner-message surface is MOUNTED (it shipped dark once already)', () => {
  it('the exact ledger of sites that mount MessageAppOwnerModal', () => {
    const mounting = productionSources().filter((rel) =>
      read(rel).includes('<MessageAppOwnerModal')
    );
    // Positive control: the scan really does see mounts, so an equal-to-ledger result
    // is a match and not an empty sweep.
    expect(mounting.length).toBeGreaterThan(0);
    expect(mounting.sort()).toEqual([...MOUNT_SITES].sort());
  });

  it('the mounting site routes the action through actionOpensOwnerMessage, not the reason modal', () => {
    const table = read(MOUNT_SITES[0]);
    // The router must be CALLED, not merely imported — an import with no call site is
    // exactly how the message action would silently fall through to
    // `setPendingAction` and open the wrong modal.
    expect(table).toContain('actionOpensOwnerMessage(action)');
    expect(table).toContain('setMessageRow(row)');
  });

  it('the modal is fed the listing ID, never the slug', () => {
    // `messageAppOwner` keys on `apl_<ULID>`; a slug would come back NOT_FOUND. The
    // row carries both and they are adjacent in the object literal, so this is a
    // realistic transposition rather than a hypothetical one.
    const table = read(MOUNT_SITES[0]);
    expect(table).toMatch(/appListingId:\s*messageRow\.id/);
  });
});

describe('the composer bounds are single-sourced from the server schema', () => {
  it('both modules import the bounds from messageAppOwnerSchema', () => {
    for (const rel of [FORM_MODULE, MODAL_MODULE]) {
      expect(read(rel)).toContain(SCHEMA_IMPORT);
    }
  });

  it('neither module hardcodes a bound as a numeric literal', () => {
    const bounds = {
      MOD_MESSAGE_SUBJECT_MIN,
      MOD_MESSAGE_SUBJECT_MAX,
      MOD_MESSAGE_BODY_MIN,
      MOD_MESSAGE_BODY_MAX,
    };
    const offences: string[] = [];
    for (const rel of [FORM_MODULE, MODAL_MODULE]) {
      const code = stripComments(read(rel));
      for (const [name, value] of Object.entries(bounds)) {
        const hits = bareNumericHits(code, value);
        if (hits > 0) offences.push(`${rel}: ${hits}× bare ${value} (use ${name})`);
      }
    }
    expect(offences).toEqual([]);
  });

  /**
   * 🔴 POSITIVE CONTROL on the detector above. A "no offences" result is
   * indistinguishable from a scan wired to nothing until the same detector has been
   * watched to FIRE — here on a synthetic source that hardcodes the body ceiling, and
   * NOT on the same source once it is written as a comment (which is the false positive
   * the comment-stripping exists to avoid).
   */
  it('the hardcoded-bound detector fires on a planted literal and not on prose', () => {
    const planted = `const max = ${MOD_MESSAGE_BODY_MAX};`;
    expect(bareNumericHits(stripComments(planted), MOD_MESSAGE_BODY_MAX)).toBe(1);

    const prose = `// the ceiling is ${MOD_MESSAGE_BODY_MAX} characters\nconst max = MOD_MESSAGE_BODY_MAX;`;
    expect(bareNumericHits(stripComments(prose), MOD_MESSAGE_BODY_MAX)).toBe(0);

    // And it must not fire on a number that merely CONTAINS the bound's digits.
    const embedded = `const other = ${MOD_MESSAGE_BODY_MAX}0;`;
    expect(bareNumericHits(stripComments(embedded), MOD_MESSAGE_BODY_MAX)).toBe(0);
  });
});
