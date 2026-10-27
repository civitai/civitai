import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyScript } from '~/server/services/blocks/apps-pipeline.service';

/**
 * RUNS the generated apply-Job script under bash, with `kubectl` and `curl` replaced by stubs
 * that log their calls, and a fake templates directory. The string tests in
 * apps-pipeline.buildApplyScript.test.ts pin the script's shape; these pin what it DOES:
 * whether the deploy fails (exit code), and which steps ran in which order.
 *
 * The fake `publish.sh` copies the FAILURE POLICY of the real one in the platform's templates
 * ConfigMap: a failure is fatal only when PUBLISH_REQUIRED=1 or the slug is listed in
 * `publish-required-slugs` (the apps the shared static server routes); any other failure prints a
 * warning and exits 0. So "the deploy failed" here means what it would mean in production.
 */

const NS = 'civitai-apps';
const SHA = 'a'.repeat(40);
const ROUTED_SLUG = 'routed-app';
const NEW_SLUG = 'brand-new-app';

const KUBECTL_STUB = `#!/usr/bin/env bash
echo "kubectl $*" >> "$CALL_LOG"
case " $* " in
  *" get "*jsonpath*) echo "10.0.0.7" ;;
esac
exit 0
`;

const CURL_STUB = `#!/usr/bin/env bash
case " $* " in
  *"/healthz"*) printf '200' ;;
  *) printf 'HTTP/1.1 200 OK\\r\\nContent-Type: text/html\\r\\n\\r\\n<html></html>\\n' ;;
esac
`;

const FAKE_PUBLISH = `#!/usr/bin/env bash
echo "publish PUBLISH_REQUIRED=\${PUBLISH_REQUIRED:-unset} SLUG=\${SLUG}" >> "$CALL_LOG"
[ "\${FAKE_PUBLISH_FAILS:-0}" = 1 ] || exit 0
if [ "\${PUBLISH_REQUIRED:-}" = 1 ] || tr -d ' \\t\\r' < "$FAKE_TEMPLATES/publish-required-slugs" | grep -qxF -- "$SLUG"; then
  echo "publish: ERROR: store down" >&2
  exit 1
fi
echo "publish: WARNING: continuing WITHOUT publishing" >&2
exit 0
`;

type RunOpts = {
  perAppObjects: boolean;
  slug: string;
  publishFails?: boolean;
  publishScript?: boolean;
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(opts: RunOpts) {
  const dir = mkdtempSync(join(tmpdir(), 'apply-script-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  const templates = join(dir, 'templates');
  mkdirSync(bin);
  mkdirSync(templates);
  const callLog = join(dir, 'calls.log');
  writeFileSync(callLog, '');

  for (const [name, body] of [
    ['kubectl', KUBECTL_STUB],
    ['curl', CURL_STUB],
  ] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(templates, 'app.yaml.tmpl'), 'kind: Deployment\nmetadata:\n  name: ${SLUG}\n');
  writeFileSync(join(templates, 'publish-required-slugs'), `# routed apps\n${ROUTED_SLUG}\n`);
  if (opts.publishScript !== false) writeFileSync(join(templates, 'publish.sh'), FAKE_PUBLISH);

  const script = buildApplyScript(NS, { perAppObjects: opts.perAppObjects });
  // The script hardcodes the Job's mount points; point them at the fixture. Guard that the
  // path being rewritten is really there, or the tests below would run against nothing.
  expect(script).toContain('/templates/publish.sh');
  const local = script
    .replaceAll('/templates/', `${templates}/`)
    .replaceAll('/tmp/rendered.yaml', join(dir, 'rendered.yaml'));
  const scriptPath = join(dir, 'apply.sh');
  writeFileSync(scriptPath, local);

  const res = spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      CALL_LOG: callLog,
      FAKE_TEMPLATES: templates,
      FAKE_PUBLISH_FAILS: opts.publishFails ? '1' : '0',
      SLUG: opts.slug,
      SHA,
      IMAGE: `ghcr.io/civitai/app-block-${opts.slug}:${SHA}`,
      APP_BLOCK_ID: 'apb_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      APPS_DOMAIN: 'example.test',
    },
    timeout: 30_000,
  });
  const calls = readFileSync(callLog, 'utf8').split('\n').filter(Boolean);
  const idx = (re: RegExp) => calls.findIndex((c) => re.test(c));
  return { status: res.status, stderr: res.stderr, calls, idx };
}

const SMOKE_RUN = /^kubectl -n civitai-apps run "?smoke-/;
const PUBLISH = /^publish /;
const APPLY = /^kubectl apply /;
const ROLLOUT = /rollout status/;

describe('apply script, per-app objects OFF (production default)', () => {
  it('smoke-tests and publishes as required, and creates no per-app object', () => {
    const r = run({ perAppObjects: false, slug: ROUTED_SLUG });
    expect(r.stderr).not.toMatch(/ERROR/);
    expect(r.status).toBe(0);
    expect(r.idx(SMOKE_RUN)).toBeGreaterThan(-1);
    expect(r.calls).toContain(`publish PUBLISH_REQUIRED=1 SLUG=${ROUTED_SLUG}`);
    expect(r.idx(PUBLISH)).toBeGreaterThan(r.idx(SMOKE_RUN));
    expect(r.calls.filter((c) => APPLY.test(c) || ROLLOUT.test(c))).toEqual([]);
  });

  // INVARIANT guard, not regression coverage: a routed app's publish failure already failed the
  // deploy before this switch existed (publish.sh treats a listed slug as required). It pins
  // that the OFF path, where publish is the only serving path, keeps it that way.
  it('fails the deploy when the publish fails', () => {
    const r = run({ perAppObjects: false, slug: ROUTED_SLUG, publishFails: true });
    expect(r.status).not.toBe(0);
    expect(r.idx(PUBLISH)).toBeGreaterThan(-1);
  });

  it('fails the deploy when the templates ship no publish script (nothing would serve it)', () => {
    const r = run({ perAppObjects: false, slug: ROUTED_SLUG, publishScript: false });
    expect(r.status).not.toBe(0);
    expect(r.calls.filter((c) => APPLY.test(c) || ROLLOUT.test(c))).toEqual([]);
  });

  it('fails the deploy, before any smoke pod or publish, for an app the static server does not route', () => {
    const r = run({ perAppObjects: false, slug: NEW_SLUG });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`${NEW_SLUG} has no route on the shared static server`);
    expect(r.idx(SMOKE_RUN)).toBe(-1);
    expect(r.idx(PUBLISH)).toBe(-1);
    expect(r.calls.filter((c) => APPLY.test(c) || ROLLOUT.test(c))).toEqual([]);
  });
});

describe('apply script, per-app objects ON (rollback)', () => {
  it('smoke-tests, publishes as required, then applies and waits for the per-app rollout', () => {
    const r = run({ perAppObjects: true, slug: NEW_SLUG });
    expect(r.status).toBe(0);
    expect(r.calls).toContain(`publish PUBLISH_REQUIRED=1 SLUG=${NEW_SLUG}`);
    expect(r.idx(SMOKE_RUN)).toBeGreaterThan(-1);
    expect(r.idx(PUBLISH)).toBeGreaterThan(r.idx(SMOKE_RUN));
    expect(r.idx(APPLY)).toBeGreaterThan(r.idx(PUBLISH));
    expect(r.idx(ROLLOUT)).toBeGreaterThan(r.idx(APPLY));
  });

  it('fails the deploy, and applies nothing, when the publish of an app not yet routed fails', () => {
    const r = run({ perAppObjects: true, slug: NEW_SLUG, publishFails: true });
    expect(r.status).not.toBe(0);
    expect(r.idx(PUBLISH)).toBeGreaterThan(-1);
    expect(r.calls.filter((c) => APPLY.test(c) || ROLLOUT.test(c))).toEqual([]);
  });
});
