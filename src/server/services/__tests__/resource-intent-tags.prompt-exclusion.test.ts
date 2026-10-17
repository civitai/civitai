import { describe, expect, it, vi } from 'vitest';
import type * as Audit from '~/utils/metadata/audit';
import {
  auditPrompt,
  includesMinor,
  includesPoi,
  MAX_AUDIT_PROMPT_LENGTH,
} from '~/utils/metadata/audit';
import { promptExcludedByAuditor } from '~/server/services/resource-intent-tags/prompt-exclusion';

const THROWS = 'sentinel prompt the auditor throws on';
vi.mock('~/utils/metadata/audit', async (importOriginal) => {
  const real = await importOriginal<typeof Audit>();
  return {
    ...real,
    auditPrompt: (p: string, ...rest: [string?, boolean?]) => {
      if (p === THROWS) throw new Error('auditor failure');
      return real.auditPrompt(p, ...rest);
    },
  };
});

describe('promptExcludedByAuditor', () => {
  it('keeps a clean prompt', () => {
    expect(promptExcludedByAuditor('a red lighthouse on a rocky coast at dusk, watercolor')).toBe(
      false
    );
  });

  it('excludes what only the regex audit rejects', () => {
    const long = 'a quiet harbor at dusk, '.repeat(Math.ceil(MAX_AUDIT_PROMPT_LENGTH / 20));
    expect(auditPrompt(long).success).toBe(false);
    expect(includesMinor(long)).toBeFalsy();
    expect(promptExcludedByAuditor(long)).toBe(true);
  });

  it('excludes what only the minor check flags', () => {
    expect(auditPrompt('a little girl').success).toBe(true);
    expect(promptExcludedByAuditor('a little girl')).toBe(true);
  });

  it('excludes a platform POI name (the regex audit runs the POI check)', () => {
    const poi = 'a drawing of diddl-maus';
    expect(includesPoi(poi)).toBeTruthy();
    expect(includesMinor(poi)).toBeFalsy();
    expect(promptExcludedByAuditor(poi)).toBe(true);
  });

  it('fails closed when the auditor throws', () => {
    expect(promptExcludedByAuditor(THROWS)).toBe(true);
  });
});
