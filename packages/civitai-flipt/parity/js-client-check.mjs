#!/usr/bin/env node
// Evaluates the parity corpus (expected.json) with ANY installed @flipt-io/flipt-client-js and
// checks it against the record for that version:
//   - the pinned version (expected.json `clients.js`): every case equals expected.json;
//   - the newest version (latest-divergences.json `latest.js`): the cases that differ from
//     expected.json are exactly the ones listed there, with exactly those results.
// The Go test makes the same two checks for go.flipt.io/flipt-client, so two clients passing the
// same check agree with each other on every case.
//
//   node packages/civitai-flipt/parity/js-client-check.mjs <dir of the installed package>
//
// .github/workflows/feed-go.yml (job `flipt-parity`) runs it against a throwaway `npm install`
// of the newest release; no network is used by the evaluation itself.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { divergencesFrom, evaluateCase, sameResult, snapshotFetcher } from './evaluate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error('usage: js-client-check.mjs <dir of an installed @flipt-io/flipt-client-js>');
  process.exit(2);
}
const pkg = readJson(path.join(pkgDir, 'package.json'));
if (pkg.name !== '@flipt-io/flipt-client-js') {
  console.error(`${pkgDir} holds ${pkg.name}, not @flipt-io/flipt-client-js`);
  process.exit(2);
}
const { FliptClient } = await import(
  pathToFileURL(path.join(pkgDir, pkg.exports['.'].node.import)).href
);

const snapshot = readJson(path.join(here, 'snapshot.json'));
const expected = readJson(path.join(here, 'expected.json'));
const latestPath = path.join(here, 'latest-divergences.json');
const latest = existsSync(latestPath) ? readJson(latestPath) : null;

let want;
if (pkg.version === expected.clients.js) want = [];
else if (latest && pkg.version === latest.latest.js && latest.baseline.js === expected.clients.js)
  want = latest.divergences;
else {
  console.error(
    `no record for @flipt-io/flipt-client-js ${pkg.version}: expected.json is for ${expected.clients.js}, ` +
      `latest-divergences.json for ${latest ? `${latest.latest.js} against ${latest.baseline.js}` : 'nothing (missing)'}`
  );
  process.exit(1);
}

// updateInterval 0: no poller (0.4.0+ default to polling every 120s when it is unset).
const client = await FliptClient.init({ fetcher: snapshotFetcher(snapshot), updateInterval: 0 });
let failed = false;
try {
  const actual = new Map(expected.cases.map((c) => [c.id, evaluateCase(client, c)]));
  const got = divergencesFrom(expected.cases, actual);
  const wantById = new Map(want.map((d) => [d.id, d]));
  const gotById = new Map(got.map((d) => [d.id, d]));
  const problems = [];
  for (const d of got) {
    const w = wantById.get(d.id);
    if (!w) problems.push(`unrecorded divergence ${d.id}: ${JSON.stringify(d.latest)}`);
    else if (!sameResult(w.latest, d.latest))
      problems.push(
        `${d.id}: recorded ${JSON.stringify(w.latest)}, got ${JSON.stringify(d.latest)}`
      );
  }
  for (const w of want) {
    if (!gotById.has(w.id)) problems.push(`recorded divergence ${w.id} did not happen`);
  }
  console.log(
    `@flipt-io/flipt-client-js ${pkg.version}: ${expected.cases.length} cases, ` +
      `${got.length} differ from ${expected.clients.js} (recorded: ${want.length})`
  );
  if (expected.cases.length < 200) problems.push(`only ${expected.cases.length} cases`);
  if (problems.length) {
    failed = true;
    for (const p of problems.slice(0, 50)) console.error(`::error::${p}`);
    if (problems.length > 50) console.error(`... and ${problems.length - 50} more`);
  }
} finally {
  client.close();
}
process.exit(failed ? 1 : 0);
