import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlockedContentHit } from '~/server/services/blocklist.service';

/**
 * Which field the title/body belt (`assertSharedTextSafe`) refuses a write for: `title`, `body`,
 * or `title and body` when only the two together trip a check. The detectors are replaced with
 * deterministic fakes keyed on distinctive fixture terms, so each case decides exactly which
 * field trips; the belt's own logic (which check, which field) stays real.
 */

const MINOR_TERM = 'zqminorterm5521';
// Two halves that trip the minor check only when they are read together.
const HALF_ONE = 'zqhalfone';
const HALF_TWO = 'zqhalftwo';
const POI_TERM = 'zqpoiterm6630';
const PATTERN_TERM = 'zqpatterm7742';
const AUDIT_TERM = 'zqauditterm8853';
const LINK_TERM = 'zqlink9061.example';

vi.mock('~/utils/metadata/audit', () => ({
  includesMinor: (text?: string) =>
    !!text && (text.includes(MINOR_TERM) || (text.includes(HALF_ONE) && text.includes(HALF_TWO))),
  includesPoi: (text?: string) => !!text && text.includes(POI_TERM),
}));
const blocklist = vi.hoisted(() => ({
  throwOnBlockedUserContent: vi.fn(),
  getBlocklistData: vi.fn(async () => [] as string[]),
  findBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', () => blocklist);
const auditPromptServer = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({ auditPromptServer }));

import { assertSharedTextSafe, SharedContentBlockedError } from '../shared-content-safety';

beforeEach(() => {
  vi.clearAllMocks();
  // The pattern list: any value carrying PATTERN_TERM, reported by index as the real one does.
  blocklist.findBlockedUserContent.mockImplementation(async (values: unknown) =>
    (values as Array<string | null | undefined>).flatMap((v, index): BlockedContentHit[] =>
      v?.includes(PATTERN_TERM)
        ? [{ kind: 'pattern', index, matched: PATTERN_TERM, patternId: 0, listId: null }]
        : v?.includes(LINK_TERM)
        ? [{ kind: 'link', index, matched: [LINK_TERM] }]
        : []
    )
  );
  blocklist.throwOnBlockedUserContent.mockImplementation(
    async (values: unknown, opts: { onBlocked?: (k: string) => never }) => {
      if ((values as Array<string | undefined>).some((v) => v?.includes(LINK_TERM))) {
        opts.onBlocked?.('link');
      }
      if ((values as Array<string | undefined>).some((v) => v?.includes(PATTERN_TERM))) {
        opts.onBlocked?.('pattern');
      }
    }
  );
  auditPromptServer.mockImplementation(async ({ prompt }: { prompt: string }) => {
    // The audit's own message names what it matched, as the real one does.
    if (prompt.includes(AUDIT_TERM)) throw new Error(`Your prompt was flagged: ${AUDIT_TERM}`);
  });
});

async function refusal(title: string, body?: string) {
  const err = await assertSharedTextSafe({ title, body, userId: 4242 }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SharedContentBlockedError);
  return err as SharedContentBlockedError;
}

describe('🔴 assertSharedTextSafe names the refused field', () => {
  it.each([
    ['minor, in the title', `a ${MINOR_TERM} story`, 'a calm lake', 'minor', 'title'],
    ['minor, in the body', 'A calm lake', `then ${MINOR_TERM} again`, 'minor', 'body'],
    ['minor, only the two together', `a ${HALF_ONE}`, `and ${HALF_TWO}`, 'minor', 'title and body'],
    ['minor, in both', `a ${MINOR_TERM}`, `b ${MINOR_TERM}`, 'minor', 'title and body'],
    ['poi, in the body', 'A calm lake', `with ${POI_TERM}`, 'poi', 'body'],
    ['pattern, in the title', `buy ${PATTERN_TERM} now`, 'a calm lake', 'pattern', 'title'],
    ['pattern, in the body', 'A calm lake', `buy ${PATTERN_TERM} now`, 'pattern', 'body'],
    ['link, in the title', `see https://${LINK_TERM}/x`, 'a calm lake', 'link', 'title'],
    ['link, in the body', 'A calm lake', `see https://${LINK_TERM}/x`, 'link', 'body'],
  ])('%s → %s / %s', async (_name, title, body, category, field) => {
    const err = await refusal(title, body);
    expect(err.category).toBe(category);
    expect(err.field).toBe(field);
  });

  it('a title-only write that trips names the title', async () => {
    expect((await refusal(`a ${MINOR_TERM}`)).field).toBe('title');
  });

  it('the refusal carries neither the matched term nor the text', async () => {
    const title = `the wizard says ${MINOR_TERM} twice`;
    const err = await refusal(title, 'a calm lake');
    const told = JSON.stringify({ message: err.message, field: err.field });
    expect(told).not.toContain(MINOR_TERM);
    expect(told).not.toContain(title);
  });

  it('an audit block is not placed: the platform audit is not re-run per field', async () => {
    const err = await refusal('A calm lake', `see ${AUDIT_TERM} here`);
    expect(err.category).toBe('audit');
    expect(err.field).toBeUndefined();
    expect(auditPromptServer).toHaveBeenCalledTimes(1);
    // 🔴 REGRESSION: the audit's own message names the matched word; the refusal must not.
    expect(err.message).toBe('Content flagged for review');
    expect(err.message).not.toContain(AUDIT_TERM);
  });

  it('a pattern hit that cannot be placed names no field (never a guess)', async () => {
    blocklist.findBlockedUserContent.mockRejectedValue(new Error('list read failed'));
    const err = await refusal(`buy ${PATTERN_TERM} now`, 'a calm lake');
    expect(err.category).toBe('pattern');
    expect(err.field).toBeUndefined();
  });
});
