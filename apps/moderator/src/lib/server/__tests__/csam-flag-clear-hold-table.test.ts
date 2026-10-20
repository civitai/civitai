import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { EVIDENCE_HOLD_TABLE } = await import('../csam-flag-clear');

const SCHEMA = fileURLToPath(
  new URL('../../../../../../packages/civitai-db-schema/prisma/schema.full.prisma', import.meta.url)
);

// The guard looks the hold table up by name and skips it while it is absent, so a rename would turn
// it off without a sound. Once the schema has the model, it must be the name the guard uses.
describe('the hold table the bulk clear checks', () => {
  it('is the one the schema defines, if the schema defines one', () => {
    const models = [...readFileSync(SCHEMA, 'utf8').matchAll(/^model (EvidenceHold\w*) \{/gm)].map(
      (m) => m[1]
    );
    if (models.length) expect(models).toContain(EVIDENCE_HOLD_TABLE);
    else expect(EVIDENCE_HOLD_TABLE).toBe('EvidenceHold');
  });
});
