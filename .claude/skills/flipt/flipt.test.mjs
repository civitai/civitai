import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { detectHtmlOrOAuth, flagsFromYaml, findFlag, formatSegments } from './flipt-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const LOGIN_HTML =
  '<!DOCTYPE html><html><head><title>Sign in</title></head><body><a href="https://github.com/login/oauth/authorize?client_id=x">Sign in with GitHub</a></body></html>';

test('HTML login page is named, not parsed', () => {
  const msg = detectHtmlOrOAuth({ status: 200, contentType: 'text/html', body: LOGIN_HTML });
  assert.match(msg, /HTML page/);
  assert.match(msg, /OAuth/);
  assert.match(msg, /NOT "flag not found"/);
});

test('302 to the OAuth host is named', () => {
  const msg = detectHtmlOrOAuth({
    status: 302,
    location: 'https://github.com/login/oauth/authorize?x=1',
    body: '',
  });
  assert.match(msg, /redirect \(302\)/);
});

test('a JSON answer is not flagged', () => {
  assert.equal(
    detectHtmlOrOAuth({ status: 200, contentType: 'application/json', body: '{"enabled":true}' }),
    null
  );
});

const yaml = 'flags:\n  - key: a\n    enabled: true\n  - key: b\n    enabled: false\n';
test('findFlag finds a defined flag and not a made-up one', () => {
  const flags = flagsFromYaml(yaml, parse);
  assert.equal(findFlag(flags, 'a').enabled, true);
  assert.equal(findFlag(flags, 'nope'), null);
});

function serve(handler) {
  return new Promise((r) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => r(s));
  });
}
function run(script, args, env) {
  return new Promise((r) =>
    execFile(
      'node',
      [script, ...args],
      { env: { ...process.env, ...env }, cwd: here },
      (e, out, err) => r({ code: e?.code ?? 0, out, err })
    )
  );
}

test('end to end: --live against an OAuth-fronted host says so', async () => {
  const s = await serve((q, res) => {
    res.writeHead(302, { location: 'https://github.com/login/oauth/authorize' });
    res.end();
  });
  const url = 'http://127.0.0.1:' + s.address().port;
  const r = await run(resolve(here, 'flipt.mjs'), ['get', 'feed-service-primary', '--live'], {
    FLIPT_LIVE_URL: url,
    FLIPT_API_TOKEN: 'dummy',
  });
  s.close();
  assert.match(r.err, /redirect \(302\)/);
  assert.doesNotMatch(r.err, /not found: /i);
});

test('--live without FLIPT_LIVE_URL refuses and names the supported path', async () => {
  const r = await run(resolve(here, 'flipt.mjs'), ['get', 'x', '--live'], {
    FLIPT_LIVE_URL: '',
    FLIPT_API_TOKEN: '',
  });
  assert.equal(r.code, 3);
  assert.match(r.err, /DevOps seat/);
});

test('formatSegments: one key, AND, and default OR', () => {
  assert.equal(formatSegments(['a']), 'a');
  assert.equal(formatSegments(['a', 'b'], 'AND_SEGMENT_OPERATOR'), 'a AND b');
  assert.equal(formatSegments(['a', 'b']), 'a OR b');
});

test('write commands refuse with exit 2', async () => {
  const r = await run(resolve(here, 'flipt.mjs'), ['enable', 'x'], {});
  assert.equal(r.code, 2);
});
