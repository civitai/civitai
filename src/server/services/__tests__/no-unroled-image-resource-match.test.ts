import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * 🔴 SOURCE GATE — resource detection may not match an image to a model on hash VALUE alone.
 *
 * WHY. The detector joins image metadata to `ModelFileHash` on hash, and nothing in that join says
 * what the hash is a hash OF. So a component file that many creators bundle beside their checkpoint
 * — an upstream text encoder, a VAE, a CLIP — matches every version hosting it, and the tie-break
 * hands the image to the earliest published of them. In production one shared text encoder credited
 * 51 images across 7 creators to a stranger's checkpoint (FD 69881), on a page the uploader could
 * not correct; 12,812 hashes sit on files owned by more than one user. Two filters restore it — the
 * role the metadata declares, and the type the uploader filed the file under.
 *
 * WHY BOTH FILES. `get_image_resources.sql` is the read and write path; `resolveImageMeta()` is a
 * hand-written mirror of it for the generator. They are the same rule in two languages with nothing
 * connecting them, so one can be fixed and the other left crediting strangers, and every suite still
 * passes. This asserts the filters exist in both — it cannot check that they AGREE.
 *
 * WHY A TEXT GATE. There is no database in the unit tier, so the behaviour is unreachable here. What
 * this protects against is the failure mode the SQL has already had: for years nothing but the
 * programmability file tracked it and the deployed body was edited out of band, so the next person
 * to redefine it starts from a copy of production. If that copy predates this fix, the filters
 * vanish with no other signal.
 */

const repoRoot = path.resolve(__dirname, '../../../..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

const SQL = 'packages/civitai-db-schema/prisma/programmability/get_image_resources.sql';
const MIRROR = 'src/server/services/generation/generation.service.ts';

describe('get_image_resources.sql', () => {
  const sql = read(SQL);

  it('declares the allowlist and actually applies it', () => {
    // Named separately: a body that keeps the vocabulary but drops the WHERE clause still fails.
    expect(sql, 'no resource_roles allowlist').toMatch(/resource_roles\s+TEXT\[\]\s*:=/);
    expect(sql, 'resource_roles is declared but never applied').toMatch(
      /irh\.role\s*=\s*ANY\s*\(\s*resource_roles\s*\)/
    );
  });

  it('refuses to match against a file that cannot be the resource', () => {
    for (const fileType of ['VAE', 'Text Encoder', 'CLIPVision', 'Training Data']) {
      expect(sql, `still matches files of type ${fileType}`).toContain(`'${fileType}'`);
    }
    expect(sql, 'never filters on mf.type').toMatch(/mf\.type\s+NOT\s+IN/i);
  });

  it('survives the db:program splitter', () => {
    // scripts/prisma-prepare-programmability.mjs splits every file on the literal `---` and runs
    // each part as its own statement, so one in a comment cuts the function in half at deploy time.
    expect(sql.includes('---'), 'contains `---`, which db:program treats as a statement separator').toBe(
      false
    );
  });
});

describe('resolveImageMeta (the TypeScript mirror)', () => {
  const mirror = read(MIRROR);

  it('drops candidates whose declared role is not a resource role', () => {
    expect(mirror, 'no RESOURCE_ROLES vocabulary').toMatch(/RESOURCE_ROLES\s*=\s*new Set\(/);
    // Both metadata shapes that carry a role have to be gated, not just one.
    const gated = mirror.match(/if \(!isResourceRole\(/g) ?? [];
    expect(gated.length, 'the role gate is missing from one of the two hash branches').toBe(2);
  });

  it('excludes the same file types the SQL does', () => {
    expect(mirror, 'no NON_RESOURCE_FILE_TYPES list').toMatch(/NON_RESOURCE_FILE_TYPES\s*=\s*\[/);
    expect(mirror, 'the file-type list is declared but never used in the query').toMatch(
      /mf\.type NOT IN \(\$\{Prisma\.join\(NON_RESOURCE_FILE_TYPES\)\}\)/
    );
  });
});
