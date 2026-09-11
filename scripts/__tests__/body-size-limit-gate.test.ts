import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NEXT_DEFAULT_PROXY_CLIENT_MAX_BODY_SIZE,
  parseSizeLimit,
  effectiveBodyLimit,
  collectDeclaredLimits,
} from '../ci/body-size-limit-gate.mjs';

const REPO_ROOT = join(__dirname, '..', '..');

describe('body-size-limit-gate', () => {
  // 🔴 THE LOAD-BEARING CASE. The gate hardcodes Next's default because reading a private
  // build artifact at runtime would make it depend on that artifact's shape. The cost of
  // hardcoding is that a Next upgrade could change the default and silently widen what the
  // gate permits — nothing would fail, the number would just be wrong. This is what makes
  // that impossible: it reads the default out of the INSTALLED Next and requires the
  // constant to match. A Next bump that moves it fails here, in one named place.
  it('pins the hardcoded default against the INSTALLED Next', () => {
    const src = readFileSync(
      join(REPO_ROOT, 'node_modules', 'next', 'dist', 'server', 'config-shared.js'),
      'utf8'
    );
    const m = /proxyClientMaxBodySize:\s*(\d+)/.exec(src);

    // Positive control on the extraction itself: if Next ever renames or restructures
    // this, "no match" must fail loudly rather than skip the comparison and read green.
    expect(m, 'could not find proxyClientMaxBodySize in the installed Next').not.toBeNull();
    expect(Number(m![1])).toBe(NEXT_DEFAULT_PROXY_CLIENT_MAX_BODY_SIZE);
  });

  it('parses every SizeLimit spelling Next accepts', () => {
    expect(parseSizeLimit('10mb')).toBe(10 * 1024 * 1024);
    expect(parseSizeLimit('500kb')).toBe(500 * 1024);
    expect(parseSizeLimit('1gb')).toBe(1024 ** 3);
    expect(parseSizeLimit('2048')).toBe(2048); // bare number = bytes
    expect(parseSizeLimit(4096)).toBe(4096);
    expect(parseSizeLimit('1.5mb')).toBe(Math.round(1.5 * 1024 * 1024));
    expect(parseSizeLimit('not-a-size')).toBeNull();
  });

  describe('effectiveBodyLimit', () => {
    it('falls back to the framework default when the config sets neither key', () => {
      const r = effectiveBodyLimit('export default { experimental: { ppr: true } };');
      expect(r.bytes).toBe(NEXT_DEFAULT_PROXY_CLIENT_MAX_BODY_SIZE);
      expect(r.source).toBe('next default');
    });

    it('reads proxyClientMaxBodySize when set', () => {
      const r = effectiveBodyLimit("experimental: { proxyClientMaxBodySize: '72mb' }");
      expect(r.bytes).toBe(72 * 1024 * 1024);
      expect(r.source).toBe('proxyClientMaxBodySize');
    });

    it('still honours the DEPRECATED middlewareClientMaxBodySize alone', () => {
      // Next maps the deprecated key onto the new one rather than ignoring it, so a repo
      // that only sets the old name really does get a raised limit. Treating it as unset
      // would make the gate fail routes that are in fact fine.
      const r = effectiveBodyLimit("experimental: { middlewareClientMaxBodySize: '30mb' }");
      expect(r.bytes).toBe(30 * 1024 * 1024);
      expect(r.source).toBe('middlewareClientMaxBodySize');
    });

    it('prefers proxyClientMaxBodySize when BOTH are present, mirroring Next', () => {
      const r = effectiveBodyLimit(
        "experimental: { middlewareClientMaxBodySize: '30mb', proxyClientMaxBodySize: '60mb' }"
      );
      expect(r.bytes).toBe(60 * 1024 * 1024);
      expect(r.source).toBe('proxyClientMaxBodySize');
    });
  });

  // Guards the SCANNER, not the routes. A zero here would make the gate vacuous — it would
  // report "0 over" forever and read as a clean repo. This is the reassuring-zero trap:
  // an empty match set is indistinguishable from a probe wired to nothing.
  it('actually finds the sizeLimit declarations in the tree', () => {
    const found = collectDeclaredLimits(join(REPO_ROOT, 'src', 'pages', 'api'), REPO_ROOT);
    expect(found.length).toBeGreaterThan(5);
    expect(found.every((f) => typeof f.bytes === 'number' && f.bytes > 0)).toBe(true);
  });

  // Keeps the recorded baseline honest: a route added over the limit without regenerating
  // makes this fail even if someone only ran the unit tier and never the gate script.
  //
  // 🔴 DELIBERATELY ONE-DIRECTIONAL, and an earlier draft got this wrong in a way that
  // punished the fix. It asserted the baseline EQUALLED the current over-limit set, so
  // lowering a baselined route's sizeLimit — the exact change this gate exists to
  // encourage — left the gate passing (fewer violations is fine) and turned this test RED.
  // It also contradicted the gate's own docstring, which promises entries may shrink or
  // disappear freely. Measured: dropping `clavata-image-process` from 17mb to 5mb gave
  // gate rc=0 and this test failing.
  //
  // The invariant that actually matters is that no CURRENT violation is UNRECORDED. A
  // baseline listing a route that no longer violates is merely stale, costs nothing, and
  // is cleaned up by --write-baseline.
  it('records every route currently over the limit (shrinking is allowed)', () => {
    const baseline = JSON.parse(
      readFileSync(join(REPO_ROOT, 'scripts', 'ci', 'body-size-limit-baseline.json'), 'utf8')
    );
    const limit = effectiveBodyLimit(readFileSync(join(REPO_ROOT, 'next.config.mjs'), 'utf8'));
    const over = collectDeclaredLimits(join(REPO_ROOT, 'src', 'pages', 'api'), REPO_ROOT).filter(
      (d: { bytes: number }) => d.bytes > limit.bytes
    );

    const unrecorded = over
      .filter((d: { file: string }) => !(d.file in baseline.routes))
      .map((d: { file: string }) => d.file);
    expect(unrecorded, 'over-limit route(s) missing from the baseline').toEqual([]);

    // A route may not quietly grow past what the baseline recorded for it either.
    const worsened = over
      .filter(
        (d: { file: string; bytes: number }) =>
          d.file in baseline.routes && d.bytes > baseline.routes[d.file]
      )
      .map((d: { file: string }) => d.file);
    expect(worsened, 'baselined route(s) declaring MORE than recorded').toEqual([]);
  });
});
