import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { stampCanonicalIframeSrc } from '~/server/services/blocks/manifest-normalize';
import { assertManifestValidAtSubmit } from '~/server/services/blocks/manifest-submit-validation';
import { previewAppBlockManifest } from '../../../../../tests/preview-app-block-manifest';

/**
 * The manifest the App Blocks preview e2e submits (`tests/preview-app-block-manifest.ts`) must pass
 * BOTH checks a submission meets:
 *  1. the platform's submit-time validator (the approve-time one, run at submit), and
 *  2. the App Blocks build pipeline's own manifest check, which runs on the review build.
 *
 * (2) is not in this repo, so its rules are restated below as LITERALS — copies, which nothing
 * here links to the build itself; the build's own tests run its real check against this
 * manifest's shape. Until this pin existed the smoke submissions passed (1) and failed (2) on
 * every run, so the review builds they trigger caught nothing.
 *
 * Cross-repo pin. `SCHEMA_REQUIRED` is asserted here against the schema FILE, and the build
 * pipeline's own test asserts its required list against the same literal. A change to the
 * schema's required list therefore fails here first, and has to be made on both sides.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const schema = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'public/schemas/app-block/v1.json'), 'utf8')
) as { required?: string[] };

/** `public/schemas/app-block/v1.json` `required`, as a literal. */
const SCHEMA_REQUIRED = ['blockId', 'version', 'name', 'contentRating', 'scopes'];

/**
 * The build pipeline's manifest check on a REVIEW build, restated: every schema-required field,
 * plus `iframe` (review builds stamp `iframe.src` into an existing iframe block), and at least one
 * surface — a non-empty `targets[]` or a `page{}` object.
 */
const PIPELINE_REVIEW_REQUIRED = [...SCHEMA_REQUIRED, 'iframe'];
function pipelineSurfaceOk(m: Record<string, unknown>): boolean {
  const hasTargets = Array.isArray(m.targets) && m.targets.length > 0;
  const hasPage = !!m.page && typeof m.page === 'object' && !Array.isArray(m.page);
  return hasTargets || hasPage;
}

// A slug distinct from every literal above, in the shape the specs derive.
const SLUG = 'ci-smoke-pub-pr-90210';
const APPS_DOMAIN = 'apps.example.test';

function fixture(): Record<string, unknown> {
  return previewAppBlockManifest({ slug: SLUG, name: 'CI drift pin' }) as Record<string, unknown>;
}

describe('preview e2e App Block manifest vs the build pipeline', () => {
  it('the schema required list is exactly the literal the build pipeline is pinned to', () => {
    expect([...(schema.required ?? [])].sort()).toEqual([...SCHEMA_REQUIRED].sort());
  });

  it('carries every field the review build requires', () => {
    const m = fixture();
    expect(PIPELINE_REVIEW_REQUIRED.filter((k) => !(k in m))).toEqual([]);
  });

  it('declares a surface (non-empty targets[] or a page{}), as the build requires', () => {
    expect(pipelineSurfaceOk(fixture())).toBe(true);
  });

  it('is deliberately minimal: no iframe.src (server-owned) and no minApiVersion (optional)', () => {
    const m = fixture();
    expect(m).not.toHaveProperty('minApiVersion');
    expect(m.iframe).not.toHaveProperty('src');
    expect(m.blockId).toBe(SLUG);
  });

  it('passes the submit-time validator once the platform stamps iframe.src', async () => {
    const stamped = stampCanonicalIframeSrc(fixture(), SLUG, APPS_DOMAIN);
    await expect(
      assertManifestValidAtSubmit({
        slug: SLUG,
        manifest: stamped,
        trustTier: null,
        existingAllowedOrigins: null,
        appsDomain: APPS_DOMAIN,
      })
    ).resolves.toBeUndefined();
  });
});
