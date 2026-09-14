#!/usr/bin/env node
/**
 * Read-only: whether a generator model version is ready, and the post-deploy instructions for
 * launching it. See SKILL.md.
 */

import { API_URL, createCli, trpcCall, whoami } from '../mod-actions/lib.mjs';
import { readCoverageRow } from '../generation-coverage/coverage.mjs';
import { describeRule, gatingRulesFor, isOwnedRule, readRules } from '../generation-gate-rules/gate.mjs';

const LAUNCH = 'node .claude/skills/generator-launch/launch.mjs';
const GATE = 'node .claude/skills/generation-gate-rules/gate.mjs';
const COVERAGE = 'node .claude/skills/generation-coverage/coverage.mjs';

const { flags, requiredInt, fail, dispatch } = createCli(['json']);

async function readState(id) {
  const [resources, rules] = await Promise.all([
    trpcCall('generation.getResourceDataByIds', { ids: [id] }, 'GET'),
    readRules(),
  ]);
  const resource = Array.isArray(resources) ? resources.find((r) => r.id === id) : undefined;
  return { resource, rules, gating: resource ? gatingRulesFor(rules, resource) : [] };
}

const blocksModerators = ({ rule }) => rule.presentation === 'hidden' && rule.availableTo === 'nobody';

async function check() {
  const id = requiredInt('version');
  const { resource, rules, gating } = await readState(id);

  let coverageRow;
  try {
    coverageRow = readCoverageRow(id, { db: flags.db }) ?? null;
  } catch (err) {
    coverageRow = `(could not query: ${err.message.split('\n').pop()})`;
  }

  if (flags.json) return console.log(JSON.stringify({ resource, coverageRow, rules }, null, 2));

  if (!resource) {
    console.log(`Version ${id}: not returned by generation.getResourceDataByIds.`);
    console.log('Either it does not exist, or it is not covered and not visible to you.');
  } else {
    console.log(`Version ${id}: ${resource.model?.name ?? '?'} — ${resource.name}`);
    console.log(`  baseModel:    ${resource.baseModel}`);
    console.log(`  status:       ${resource.status} (${resource.availability})`);
    console.log(`  usageControl: ${resource.usageControl}`);
    console.log(`  covered:      ${resource.covered}`);
    console.log(`  canGenerate:  ${resource.canGenerate} (for you)`);
  }
  console.log(
    `  EcosystemCheckpoints: ${
      typeof coverageRow === 'string' ? coverageRow : coverageRow ? `yes ("${coverageRow.name}")` : 'no'
    }`
  );

  console.log(gating.length ? '\nGate rules hiding it:' : '\nNo gate rule hides this version or its ecosystem.');
  for (const { rule } of gating) console.log(describeRule(rule));

  const killSwitches = gating.filter(blocksModerators);
  if (resource && !resource.canGenerate && resource.covered && killSwitches.length)
    console.log(
      `\ncanGenerate is false because ${killSwitches.map(({ rule }) => rule.id).join(', ')} is available to` +
        ' "nobody", which hides it from moderators too. Use "moderators" to let mods test.'
    );
}

async function launch() {
  const id = requiredInt('version');
  const { resource, gating } = await readState(id);
  if (!resource) fail(`version ${id} was not returned by generation.getResourceDataByIds`);
  const model = await trpcCall('model.getById', { id: resource.model.id }, 'GET');

  const published = resource.status === 'Published';
  const box = (done) => (done ? '[x]' : '[ ]');

  console.log(`Launch: ${model.name} — ${resource.name} (version ${id})`);
  console.log(`
Do these after the deploy has landed, in this order. Publish BEFORE removing the gate: while
the gate rule stands, a published version stays hidden from everyone except moderators, so
publishing exposes nothing early. The other order shows everyone a Draft model they cannot
generate with.`);

  console.log(`
1. ${box(resource.canGenerate)} Test as a moderator — generate with it in the generator on ${API_URL}.
       ${LAUNCH} check --version ${id}        (expect canGenerate: true)`);
  if (!resource.canGenerate)
    console.log('       Currently false for you. Do not publish until this passes — `check` says why.');

  console.log(`
2. ${box(published)} Publish.
       Open ${API_URL}/models/${model.id}?modelVersionId=${id}
       and click the green "Publish" button in the version panel.
       ${
         model.status === 'Published'
           ? 'The model is already published, so this publishes only this version.'
           : `The model is still ${model.status}, so this publishes the model and this version together.`
       }
       To pick a date instead, use the schedule button beside it.
       ${LAUNCH} check --version ${id}        (expect status: Published)`);

  console.log(`\n3. ${box(!gating.length)} Remove the gate.`);
  if (!gating.length) console.log('       No gate rule hides this version or its ecosystem.');
  for (const { rule, targets } of gating) {
    const owned = isOwnedRule(rule);
    const fromRule = owned ? '' : ` --from-rule ${rule.id}`;
    console.log(
      `       Rule ${rule.id} — ${rule.presentation}, available to ${rule.availableTo}, ${
        owned ? 'added by generation-gate-rules' : `set by hand ("${rule.name}")`
      }:`
    );
    for (const target of targets) console.log(`       ${GATE} remove ${target}${fromRule} --writable`);
  }
  if (gating.some(({ targets }) => targets.some((t) => t.startsWith('--ecosystem'))))
    console.log('       Removing an ecosystem target un-hides every version in that ecosystem.');
  console.log(`       ${GATE} list                    (confirm nothing still names it)`);

  console.log(`
4. [ ] Confirm as a non-mod: open the generator in a private window (or signed in as a non-mod)
       and select it. Rules are read per request, so this takes effect immediately.`);

  console.log(`
5. Only if they apply:
       - "GenerationBaseModel" row, so community resources on downloadable weights can generate
       - "AuctionBase" row, for a paid featured-resources auction (a product decision)
       - add-training-support and ecosystem-seo-page skills`);
  if (resource.usageControl === 'ExternalGeneration')
    console.log(`       - Optional: ${COVERAGE} remove --version ${id} --writable
         once published, so a later unpublish also removes coverage (branch 2 covers it meanwhile)`);
}

const HELP = `Usage: ${LAUNCH} <command> [flags]

  whoami
  check    --version <id> [--db prod|dev] [--json]   is it covered, generatable, and gated?
  launch   --version <id>                            post-deploy instructions: publish, then remove the gate

Both are read-only.`;

dispatch({ whoami, check, launch }, HELP);
