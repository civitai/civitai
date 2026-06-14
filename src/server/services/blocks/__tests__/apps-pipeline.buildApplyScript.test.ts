import { describe, expect, it } from 'vitest';

/**
 * buildApplyScript() emits the bash the apply Job runs to smoke-test the
 * candidate image and roll out the per-app manifest. It is a pure function of
 * the namespace, but the script is security- and correctness-sensitive:
 *
 *   - it MUST be strict-mode bash (`set -euo pipefail`) so a failed smoke
 *     step aborts the apply instead of shipping a broken image;
 *   - the caller-supplied namespace is interpolated into every `kubectl -n`
 *     invocation — pin that it lands on all of them so an apply can never be
 *     misdirected to the wrong namespace;
 *   - the per-run shell vars (SLUG / SHA / IMAGE / APP_BLOCK_ID / APPS_DOMAIN)
 *     must stay SHELL expansions (`${SLUG}`), NOT be interpolated by JS — they
 *     come from the Job env at runtime, not from this builder;
 *   - the smoke-pod name is capped at an 8-char short sha to stay under the
 *     63-char DNS label limit (the 2026-05-30 incident class);
 *   - the three smoke probes (healthz 200, / 200 text/html, no :8080 port-leak
 *     redirect) and the cleanup trap must all be present — these are the
 *     gen-from-model mixed-content / ImagePullBackOff guards.
 *
 * Pure function → no mocks needed.
 */

import { buildApplyScript } from '~/server/services/blocks/apps-pipeline.service';

describe('buildApplyScript', () => {
  const NS = 'civitai-apps';
  const script = buildApplyScript(NS);

  it('is strict-mode bash so a failed step aborts the apply', () => {
    expect(script).toContain('#!/usr/bin/env bash');
    expect(script).toContain('set -euo pipefail');
  });

  it('namespaces every kubectl command except the manifest-scoped apply', () => {
    // Match EVERY kubectl invocation anywhere in the EXECUTABLE script (incl.
    // ones inside `if ! kubectl …` and `$(kubectl …)` — a `kubectl -n` regex
    // misses those). Strip `#` comment lines first so a future comment that
    // happens to contain `kubectl` can't inflate the namespaced count or fake
    // an offender.
    const executable = script
      .split('\n')
      .filter((line: string) => !/^\s*#/.test(line))
      .join('\n');
    const invocations = [...executable.matchAll(/kubectl\s+([^\n]*)/g)].map((m) => m[1].trim());
    expect(invocations.length).toBeGreaterThan(0);

    // The ONLY un-namespaced kubectl is the manifest-scoped `apply` — its target
    // namespace lives inside /tmp/rendered.yaml (pinned by the app-templates
    // ConfigMap, enforced out of scope of this unit). EVERYTHING else must be
    // `-n ${NS}`-scoped. This catches (a) a dropped `-n` on the smoke/wait/get/
    // describe/logs/rollout commands, (b) a NEW un-namespaced kubectl command,
    // and (c) a wrong-namespace leak — none of which the old `-n \S+`-only
    // regex could see (it never inspected the apply, the highest-blast command).
    const APPLY = 'apply -f /tmp/rendered.yaml';
    const offenders = invocations.filter(
      (inv) => !inv.startsWith(`-n ${NS} `) && !inv.startsWith(APPLY)
    );
    expect(offenders).toEqual([]);
    // …and the apply is the SOLE un-namespaced command (exactly one).
    expect(invocations.filter((inv) => !inv.startsWith(`-n ${NS} `))).toEqual([APPLY]);
    // Sanity: the namespaced commands really exist (run/wait/get/describe/logs/rollout).
    expect(invocations.filter((inv) => inv.startsWith(`-n ${NS} `)).length).toBeGreaterThanOrEqual(4);
  });

  it('routes a distinct namespace argument through unchanged (no hardcoded ns)', () => {
    const other = buildApplyScript('some-other-ns');
    expect(other).toContain('kubectl -n some-other-ns run');
    expect(other).not.toContain('kubectl -n civitai-apps');
  });

  it('leaves per-run vars as SHELL expansions, not JS-interpolated values', () => {
    // If these had been JS template-interpolated they'd be empty/undefined.
    for (const v of ['${SLUG}', '${SHA}', '${IMAGE}', '${APP_BLOCK_ID}', '${APPS_DOMAIN}']) {
      expect(script).toContain(v);
    }
    expect(script).not.toContain('undefined');
  });

  it('caps the smoke-pod name at an 8-char short sha (DNS 63-char label guard)', () => {
    expect(script).toContain(`SMOKE_POD="smoke-\${SLUG}-$(printf '%s' "\${SHA}" | head -c 8)"`);
  });

  it('pins the smoke pod hardening: private-registry pull + non-root + drop-ALL caps', () => {
    expect(script).toContain('imagePullSecrets');
    expect(script).toContain('ghcr-cred');
    expect(script).toContain('automountServiceAccountToken":false');
    expect(script).toContain('runAsNonRoot":true');
    expect(script).toContain('"drop":["ALL"]');
    expect(script).toContain('RuntimeDefault');
  });

  it('always cleans up the smoke pod via an EXIT trap', () => {
    expect(script).toContain('trap cleanup EXIT');
    expect(script).toContain('delete pod "${SMOKE_POD}"');
    expect(script).toContain('--ignore-not-found=true');
  });

  it('runs all three smoke probes (healthz, root html, port-leak redirect)', () => {
    expect(script).toContain('/healthz');
    expect(script).toContain('GET /healthz returned');
    expect(script).toContain('expected text/html');
    // The mixed-content port-leak guard rejects any :8080 in a redirect Location.
    expect(script).toContain("grep -q ':8080'");
    expect(script).toContain('leaks the in-pod port');
  });

  it('applies the rendered manifest and waits for the rollout last', () => {
    const applyIdx = script.indexOf('kubectl apply -f /tmp/rendered.yaml');
    const rolloutIdx = script.indexOf('rollout status deploy/${SLUG}');
    expect(applyIdx).toBeGreaterThan(-1);
    expect(rolloutIdx).toBeGreaterThan(applyIdx);
    // The apply must come AFTER the smoke test passes.
    const smokePassIdx = script.indexOf('smoke test: PASSED');
    expect(applyIdx).toBeGreaterThan(smokePassIdx);
  });
});
