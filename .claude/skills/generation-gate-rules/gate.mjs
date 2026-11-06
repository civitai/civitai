#!/usr/bin/env node
/**
 * Generation gate rules: hide a generator ecosystem or model version from everyone except
 * moderators, or disable it with a message during an outage, and remove either again.
 * See SKILL.md. Writes are dry runs unless --writable.
 */

import { API_URL, createCli, isMain, trpcCall, whoami } from '../mod-actions/lib.mjs';

const OWNED_RULE_PREFIX = 'onboard-';
export const isOwnedRule = (rule) => rule.id.startsWith(OWNED_RULE_PREFIX);

const INCIDENT_RULE_PREFIX = 'incident-';
export const isIncidentRule = (rule) => rule.id.startsWith(INCIDENT_RULE_PREFIX);

export async function readRules() {
  return (await trpcCall('generation.getGateRules', undefined, 'GET')) ?? [];
}

export function describeRule(rule) {
  const targets = [
    rule.ecosystems.length && `ecosystems: ${rule.ecosystems.join(', ')}`,
    rule.workflows.length && `workflows: ${rule.workflows.join(', ')}`,
    rule.modelVersionIds.length && `versions: ${rule.modelVersionIds.join(', ')}`,
  ].filter(Boolean);
  return `${rule.id}  "${rule.name}"  ${rule.presentation}, available to ${rule.availableTo}\n    ${
    targets.join(' | ') || '(no targets)'
  }${rule.message ? `\n    message: ${rule.message}` : ''}`;
}

// The other presentation (`experimental`) annotates a usable item and gates nothing.
const GATING_PRESENTATIONS = ['hidden', 'disabled'];

/**
 * The rules that gate a resource from `generation.getResourceDataByIds`, each with the
 * `gate.mjs remove` target flags that would lift it.
 *
 * The AIR carries the ROOT ecosystem, lowercased, so a rule on a child ecosystem is not matched.
 */
export function gatingRulesFor(rules, resource) {
  const airEcosystem = resource.air?.split(':')[2];
  const matchesEcosystem = (key) => !!airEcosystem && key.toLowerCase() === airEcosystem;
  return rules
    .filter((r) => GATING_PRESENTATIONS.includes(r.presentation))
    .flatMap((rule) => {
      const targets = [
        ...rule.ecosystems.filter(matchesEcosystem).map((key) => `--ecosystem ${key}`),
        ...(rule.modelVersionIds.includes(resource.id) ? [`--version ${resource.id}`] : []),
      ];
      return targets.length ? [{ rule, targets }] : [];
    });
}

if (isMain(import.meta.url)) {
  const { flags, writable, required, requiredInt, fail, dryRun, dispatch } = createCli(['writable', 'json']);

  const gateTarget = () => {
    if (flags.ecosystem && flags.version) fail('pass --ecosystem or --version, not both');
    if (flags.ecosystem) {
      const key = required('ecosystem');
      return {
        list: 'ecosystems',
        value: key,
        ruleId: `${OWNED_RULE_PREFIX}eco-${key}`,
        incidentKey: key.toLowerCase(),
        label: `ecosystem ${key}`,
      };
    }
    if (flags.version) {
      const id = requiredInt('version');
      return {
        list: 'modelVersionIds',
        value: id,
        ruleId: `${OWNED_RULE_PREFIX}mv-${id}`,
        incidentKey: `mv-${id}`,
        label: `version ${id}`,
      };
    }
    fail('pass --ecosystem <key> or --version <id>');
  };

  const list = async () => {
    const rules = await readRules();
    if (flags.json) return console.log(JSON.stringify(rules, null, 2));
    if (!rules.length) return console.log('No gate rules.');
    for (const rule of rules) console.log(describeRule(rule));
  };

  const add = async () => {
    const target = gateTarget();
    const rules = await readRules();

    const others = rules.filter((r) => r.id !== target.ruleId && r[target.list].includes(target.value));
    for (const r of others) console.log(`Note: ${target.label} is already in rule ${r.id} ("${r.name}").`);

    const existing = rules.find((r) => r.id === target.ruleId);
    if (existing) {
      console.log(`Rule ${target.ruleId} already exists — nothing to do:`);
      return console.log(describeRule(existing));
    }

    const rule = {
      id: target.ruleId,
      name: `Onboarding: ${target.label}`,
      availableTo: 'moderators',
      presentation: 'hidden',
      message: flags.message ?? null,
      ecosystems: target.list === 'ecosystems' ? [target.value] : [],
      workflows: [],
      modelVersionIds: target.list === 'modelVersionIds' ? [target.value] : [],
    };

    if (!writable) return dryRun('generation.saveGateRule', rule);
    await trpcCall('generation.saveGateRule', rule);
    console.log(`Added rule:\n${describeRule(rule)}`);
  };

  const remove = async () => {
    const target = gateTarget();
    const fromRule = flags['from-rule'];
    const rules = await readRules();

    if (fromRule) {
      const rule = rules.find((r) => r.id === fromRule);
      if (!rule) fail(`no rule with id ${fromRule}`);
      if (!rule[target.list].includes(target.value)) fail(`${target.label} is not in rule ${fromRule}`);
      const updated = { ...rule, [target.list]: rule[target.list].filter((v) => v !== target.value) };
      if (!writable) return dryRun('generation.saveGateRule', updated);
      await trpcCall('generation.saveGateRule', updated);
      return console.log(`Removed ${target.label} from rule ${fromRule}.`);
    }

    if (!rules.some((r) => r.id === target.ruleId)) {
      const others = rules.filter((r) => r[target.list].includes(target.value));
      if (!others.length) return console.log(`No rule gates ${target.label}.`);
      console.log(`No rule of this skill's for ${target.label}, but these rules gate it:`);
      for (const r of others) console.log(describeRule(r));
      return console.log('Re-run with --from-rule <id> to remove it from one of them.');
    }

    if (!writable) {
      console.log(`[dry run] generation.deleteGateRule → ${API_URL}`);
      console.log(`Would delete rule ${target.ruleId} (${target.label}).`);
      return console.log('Re-run with --writable to apply.');
    }
    await trpcCall('generation.deleteGateRule', { id: target.ruleId });
    console.log(`Removed ${target.label} (deleted rule ${target.ruleId}).`);
  };

  // One incident rule per target per UTC day, so a second disable the same day rewrites it.
  const disable = async () => {
    const target = gateTarget();
    const message = required('message');
    const ruleId = `${INCIDENT_RULE_PREFIX}${target.incidentKey}-${new Date().toISOString().slice(0, 10)}`;
    const rules = await readRules();

    const open = rules.filter(
      (r) => isIncidentRule(r) && r.id !== ruleId && r[target.list].includes(target.value)
    );
    for (const r of open) console.log(`Note: ${target.label} is already disabled by ${r.id}.`);

    const rule = {
      id: ruleId,
      name: `Incident: ${target.label}`,
      availableTo: 'moderators',
      presentation: 'disabled',
      message,
      ecosystems: target.list === 'ecosystems' ? [target.value] : [],
      workflows: [],
      modelVersionIds: target.list === 'modelVersionIds' ? [target.value] : [],
    };

    if (!writable) return dryRun('generation.saveGateRule', rule);
    await trpcCall('generation.saveGateRule', rule);
    const saved = (await readRules()).find((r) => r.id === ruleId);
    if (!saved) fail(`saved ${ruleId} but it is not in the rules read back`);
    console.log(`Disabled:\n${describeRule(saved)}`);
  };

  const enable = async () => {
    const target = gateTarget();
    const rules = await readRules();
    const incidents = rules.filter((r) => isIncidentRule(r) && r[target.list].includes(target.value));
    if (!incidents.length) return console.log(`No incident rule disables ${target.label}.`);

    const shared = incidents.filter(
      (r) => r.ecosystems.length + r.workflows.length + r.modelVersionIds.length > 1
    );
    if (shared.length)
      fail(`${shared.map((r) => r.id).join(', ')} cover more than ${target.label}; edit by hand`);

    if (!writable) {
      console.log(`[dry run] generation.deleteGateRule → ${API_URL}`);
      for (const r of incidents) console.log(`Would delete:\n${describeRule(r)}`);
      return console.log('Re-run with --writable to apply.');
    }
    for (const r of incidents) await trpcCall('generation.deleteGateRule', { id: r.id });
    const left = (await readRules()).filter((r) => incidents.some((i) => i.id === r.id));
    if (left.length) fail(`still present after delete: ${left.map((r) => r.id).join(', ')}`);
    console.log(`Enabled ${target.label} (deleted ${incidents.map((r) => r.id).join(', ')}).`);
  };

  const HELP = `Usage: node .claude/skills/generation-gate-rules/gate.mjs <command> [flags]

  whoami
  list     [--json]
  add      --ecosystem <key> | --version <id> [--message <m>] [--writable]
           (always "available to moderators, hidden")
  remove   --ecosystem <key> | --version <id> [--from-rule <id>] [--writable]
  disable  --ecosystem <key> | --version <id> --message <m> [--writable]
           (outage: "available to moderators, disabled", shown with the message)
  enable   --ecosystem <key> | --version <id> [--writable]
           (deletes the incident rules that disable the target)`;

  dispatch({ whoami, list, add, remove, disable, enable }, HELP);
}
