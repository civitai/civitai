import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../../../../../test/source-scan';
import { stripComments } from '../../../../../test/strip-comments';

/**
 * RELATIONSHIP GUARD: the org names live in ONE file. The submit flow creates the review repo in
 * one module (`forgejo.service.ts`) and commits to it from another (`publish-request.service.ts`);
 * if either named its org itself, a preview would create in its own org and write to production's
 * (or the reverse). So no production source file outside `forgejo-orgs.ts` may spell an org name
 * as a string literal. Comments are stripped; literals are what is matched.
 *
 * `server-schema.ts` names `civitai-apps` as the default of APPS_KUBE_NAMESPACE, which is a
 * Kubernetes namespace, not a Forgejo org. `appFeedbackInbox.ts` quotes two org names inside
 * user-facing help text (a `git fetch` instruction), which addresses nothing.
 */
const LITERAL_LEDGER: Record<string, string[]> = {
  'src/server/services/blocks/forgejo-orgs.ts': [
    'civitai-apps',
    'civitai-apps-review',
    'civitai-apps-src',
  ],
  'src/env/server-schema.ts': ['civitai-apps'],
  'src/components/Apps/appFeedbackInbox.ts': ['civitai-apps-src', 'civitai-apps'],
};

/** A string literal (any quote) whose whole content is an org name. */
const ORG_LITERAL = /(['"`])(civitai-apps(?:-review|-src)?)\1/g;

describe('Forgejo org literals ledger', () => {
  const ROOT = process.cwd();
  const files = sourceFiles(ROOT);

  function literalsIn(file: string): string[] {
    const code = stripComments(readFileSync(join(ROOT, file), 'utf8'));
    return [...code.matchAll(ORG_LITERAL)].map((m) => m[2]);
  }

  it('scans a real population (positive control: forgejo-orgs.ts is in it and matches)', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(literalsIn('src/server/services/blocks/forgejo-orgs.ts')).toEqual(
      LITERAL_LEDGER['src/server/services/blocks/forgejo-orgs.ts']
    );
  });

  it('matches the org literals exactly where the ledger says, and nowhere else', () => {
    const found: Record<string, string[]> = {};
    for (const f of files) {
      const hits = literalsIn(f);
      if (hits.length) found[f] = hits;
    }
    expect(found).toEqual(LITERAL_LEDGER);
  });
});
