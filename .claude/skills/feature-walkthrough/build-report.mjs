#!/usr/bin/env node
// Inline captured screenshots into a report template, ready to publish as an Artifact.
//
//   node .claude/skills/feature-walkthrough/build-report.mjs <template.html> <shots-dir> <out.html>
//
// Artifacts run under a CSP that blocks every external host, so a page that references
// screenshots by path or URL renders as a column of broken images. Each `{{name.png}}` in the
// template becomes a base64 data: URI of `<shots-dir>/name.png`.
//
// A missing image is a hard error. Publishing a walkthrough with a silently absent screenshot is
// worse than not publishing it — the reader cannot tell the difference between "no screenshot"
// and "this state does not exist".

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const [template, shotsDir, outFile] = process.argv.slice(2);
if (!template || !shotsDir || !outFile) {
  console.error('usage: build-report.mjs <template.html> <shots-dir> <out.html>');
  process.exit(1);
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const ARTIFACT_LIMIT = 16 * 1024 * 1024;

const src = readFileSync(template, 'utf8');
const missing = [];
const used = new Set();

const out = src.replace(/\{\{([^}]+)\}\}/g, (match, name) => {
  const file = join(shotsDir, name.trim());
  const mime = MIME[extname(file).toLowerCase()];
  if (!mime) {
    missing.push(`${name} (unsupported extension)`);
    return match;
  }
  if (!existsSync(file)) {
    missing.push(name);
    return match;
  }
  used.add(name.trim());
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
});

if (missing.length) {
  console.error(`Missing ${missing.length} image(s) referenced by the template:`);
  for (const name of missing) console.error(`  - ${name}`);
  process.exit(1);
}

writeFileSync(outFile, out);

const bytes = Buffer.byteLength(out);
const mb = (bytes / 1024 / 1024).toFixed(2);
console.log(`Wrote ${outFile}`);
console.log(`  images inlined : ${used.size}`);
console.log(`  size           : ${mb} MB`);

if (bytes > ARTIFACT_LIMIT) {
  console.error(`  OVER the ${ARTIFACT_LIMIT / 1024 / 1024} MB artifact limit — the publish will be rejected.`);
  console.error('  Capture tighter regions, or drop the screenshots that repeat a state.');
  process.exit(1);
}
if (bytes > ARTIFACT_LIMIT * 0.75) {
  console.warn('  Close to the artifact limit. Prefer element shots over full-page ones.');
}
