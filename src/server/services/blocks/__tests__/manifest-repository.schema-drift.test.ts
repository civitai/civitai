import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  MAX_REPOSITORY_URL_LENGTH,
  REPOSITORY_HOST_ALLOWLIST,
  validateRepositoryUrl,
} from '~/server/schema/blocks/external-app.schema';
import { BlockManifestValidator } from '~/server/services/block-manifest-validator.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Drift guard — manifest `repository`.
 *
 * TWO declarations of the same rule, and they must never diverge:
 *   1. the canonical published schema `public/schemas/app-block/v1.json` — what the
 *      `civitai` CLI byte-mirrors, what editors validate against, and what an author
 *      sees BEFORE they submit,
 *   2. `validateRepositoryUrl` — the imperative validator, the authoritative gate at
 *      submit/approve.
 *
 * 🔴 THE DIRECTION OF DIVERGENCE THAT HURTS is the schema being MORE PERMISSIVE than
 * the server: an author green in their editor and rejected at submit, with nothing to
 * explain the difference. So this guard checks not just the shared bound but that the
 * schema's own `pattern` rejects at least the host-shaped cases the server rejects.
 *
 * 🔴 AND IT CHECKS THE DESCRIPTION, because for THIS field the prose is a
 * machine-checkable claim: it enumerates the accepted hosts to the author. A host
 * added to `REPOSITORY_HOST_ALLOWLIST` and not to the description leaves the published
 * schema telling every App Block developer something false.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'public/schemas/app-block/v1.json');

type RepositorySchema = {
  type?: unknown;
  description?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  pattern?: unknown;
};

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
  required?: unknown;
  properties?: { repository?: RepositorySchema };
};

describe('app-block v1 schema ⇄ repository rule drift guard', () => {
  it('declares repository as an OPTIONAL non-empty string', () => {
    const repository = schema.properties?.repository;
    expect(repository).toBeDefined();
    expect(repository?.type).toBe('string');
    expect(repository?.minLength).toBe(1);
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    expect(required).not.toContain('repository');
  });

  it('schema maxLength equals the validator cap MAX_REPOSITORY_URL_LENGTH', () => {
    expect(schema.properties?.repository?.maxLength).toBe(MAX_REPOSITORY_URL_LENGTH);
  });

  it('🔴 the schema DESCRIPTION names exactly the hosts REPOSITORY_HOST_ALLOWLIST contains', () => {
    // The published schema is documentation an author reads. A host in the code and
    // not in the prose is a silent capability; a host in the prose and not in the code
    // is a promise the submit path breaks. Both directions asserted.
    const description = String(schema.properties?.repository?.description ?? '');
    expect(description.length).toBeGreaterThan(0);
    for (const host of REPOSITORY_HOST_ALLOWLIST) {
      expect(description, `description omits the accepted host ${host}`).toContain(host);
    }
    // The reverse: no host is advertised that the validator does not accept. Scan the
    // description for anything domain-shaped and require it to be either an allowlisted
    // host or one of the hosts the description explicitly calls out as REJECTED.
    const REJECTED_EXAMPLES = ['www.github.com', 'gist.github.com', 'raw.githubusercontent.com'];
    const advertised = description.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/g) ?? [];
    for (const token of advertised) {
      if ((REPOSITORY_HOST_ALLOWLIST as readonly string[]).includes(token)) continue;
      if (REJECTED_EXAMPLES.includes(token)) continue;
      // Prose also contains file paths (`external-app.schema.ts`) and constant names;
      // those are not host claims. Only flag a token that LOOKS like a bare domain.
      if (/\.(ts|tsx|js|json|md|sql)$/.test(token)) continue;
      throw new Error(
        `the schema description advertises "${token}", which is neither an allowlisted ` +
          `host nor one of the documented rejected examples`
      );
    }
  });

  it('🔴 the schema PATTERN is never MORE permissive than the validator, host-wise', () => {
    const pattern = String(schema.properties?.repository?.pattern ?? '');
    expect(pattern.length).toBeGreaterThan(0);
    const re = new RegExp(pattern);

    // Every accepted host must pass the pattern — otherwise the schema rejects a value
    // submit would accept (annoying, but the safe direction; still wrong).
    for (const host of REPOSITORY_HOST_ALLOWLIST) {
      const url = `https://${host}/owner/repo`;
      expect(re.test(url), `pattern rejects the accepted ${url}`).toBe(true);
      expect(validateRepositoryUrl(url).ok).toBe(true);
    }

    // …and every one of these must fail BOTH. A case that the pattern lets through
    // while the validator rejects it is the divergence that actually hurts an author.
    for (const bad of [
      'http://github.com/o/r',
      'https://www.github.com/o/r',
      'https://gist.github.com/o/r',
      'https://raw.githubusercontent.com/o/r',
      'https://bitbucket.org/o/r',
      'https://github.com',
      'https://github.com/o/r/tree/main',
    ]) {
      expect(validateRepositoryUrl(bad).ok, `validator accepted ${bad}`).toBe(false);
      expect(re.test(bad), `schema pattern accepted ${bad}, which submit rejects`).toBe(false);
    }
  });
});

describe('BlockManifestValidator ⇄ validateRepositoryUrl (one rule, not two)', () => {
  /**
   * A manifest that is valid in every OTHER respect, plus whatever the case adds — so a
   * rejection below can only be about `repository`. Mirrors `VALID_MANIFEST` /`APP_CTX`
   * in `block-manifest-validator.service.test.ts`: the validator gates `iframe.src`
   * against the app's registered `allowedOrigins`, so the context is REQUIRED (the
   * bare-number form defaults `allowedOrigins` to `[]` and correctly rejects).
   */
  const APP_CTX = {
    allowedScopes: TokenScope.ModelsRead,
    allowedOrigins: ['https://blocks.civitai.com'],
  };

  function manifest(extra: Record<string, unknown> = {}) {
    return {
      blockId: 'my-app',
      version: '1.0.0',
      name: 'My App',
      contentRating: 'g',
      renderMode: 'iframe',
      trustTier: 'unverified',
      scopes: ['models:read:self'],
      iframe: {
        src: 'https://blocks.civitai.com/test',
        minHeight: 200,
        maxHeight: null,
        resizable: true,
        sandbox: 'allow-scripts',
      },
      ...extra,
    };
  }

  function errorsFor(extra: Record<string, unknown>): string[] {
    const res = BlockManifestValidator.validate(manifest(extra), APP_CTX);
    return res.valid ? [] : res.errors;
  }

  it('POSITIVE CONTROL: the base manifest is valid, so a rejection below is about `repository`', () => {
    // Without this, a fixture broken for an unrelated reason would make every
    // "rejects X" case below pass vacuously.
    expect(errorsFor({})).toEqual([]);
  });

  it('an ABSENT repository key is fine (the field is optional)', () => {
    expect(errorsFor({})).toEqual([]);
  });

  it('accepts a valid repository on each allowlisted host', () => {
    for (const host of REPOSITORY_HOST_ALLOWLIST) {
      expect(errorsFor({ repository: `https://${host}/owner/repo` })).toEqual([]);
    }
  });

  it.each([
    ['http scheme', 'http://github.com/o/r'],
    ['a non-allowlisted host', 'https://gist.github.com/o/deadbeef'],
    ['a deep path', 'https://github.com/o/r/tree/main'],
    ['embedded credentials', 'https://u:p@github.com/o/r'],
    ['a blank string', '   '],
  ])('rejects %s at the manifest boundary', (_label, repository) => {
    const errors = errorsFor({ repository });
    expect(errors.length).toBeGreaterThan(0);
    // 🔴 The error must name the MANIFEST key. An author editing `block.manifest.json`
    // has no field called `sourceRepoUrl`; a message about one sends them nowhere.
    expect(errors.join(' | ')).toContain('repository');
    expect(errors.join(' | ')).not.toContain('sourceRepoUrl');
  });

  it('rejects a non-string repository', () => {
    expect(errorsFor({ repository: 42 }).join(' | ')).toContain('repository must be a string');
  });

  it('🔴 the manifest gate and the listing gate agree on EVERY case — no second copy of the rule', () => {
    // The on-site path (this validator) and the off-site path (`validateRepositoryUrl`,
    // called by buildListingPatchData/submitExternalListing) must never disagree about
    // what a valid source link is; a manifest accepted here and a listing patch rejected
    // there would be indistinguishable from a bug in either.
    const corpus = [
      'https://github.com/o/r',
      'https://gitlab.com/o/r',
      'https://codeberg.org/o/r',
      'https://github.com/o/r.git',
      'https://GITHUB.COM/o/r/',
      'http://github.com/o/r',
      'https://www.github.com/o/r',
      'https://raw.githubusercontent.com/o/r',
      'https://github.com/o',
      'https://github.com/o/r/tree/main',
      'https://u:p@github.com/o/r',
      '   ',
      'not a url',
    ];
    for (const value of corpus) {
      const manifestOk = errorsFor({ repository: value }).length === 0;
      const listingOk = validateRepositoryUrl(value).ok;
      expect(manifestOk, `disagreement on ${JSON.stringify(value)}`).toBe(listingOk);
    }
  });
});
