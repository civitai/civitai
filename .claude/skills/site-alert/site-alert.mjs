#!/usr/bin/env node

/**
 * Site alerts - post, edit, extend, end and list the incident banners shown at the top of
 * matching civitai.com pages.
 *
 * Commands:
 *   list                    Every alert, active and ended in the last 7 days
 *   active                  What the public endpoint serves right now
 *   post                    Post an alert (--title and --hours required)
 *   edit <id>               Change an alert's copy or targeting
 *   extend <id>             Push an alert's end out (--minutes or --hours)
 *   end <id>                End an alert now
 *
 * Options:
 *   --title <text>          Headline (max 120)
 *   --message <text>        Detail line (max 500)
 *   --severity <s>          info | warning | outage | resolved (default warning)
 *   --paths <a,b>           Comma-separated path globs; * = one segment, ** = any. Omit for every page
 *   --domains <a,b>         all | blue | green | red (default all)
 *   --hours <n>             post: ends this many hours after it starts (max 168); extend: added hours
 *   --minutes <n>           extend: added minutes
 *   --starts <iso>          post: schedule a start time
 *   --dismissible           Visitors can dismiss it (default: yes, except outages)
 *   --not-dismissible       Visitors cannot dismiss it
 *   --dry-run               Print the request instead of making it
 *   --json                  Raw JSON output
 */

import { API_URL, isMain, requireApiKey, run, trpcCall } from '../mod-actions/lib.mjs';

const BOOLEANS = ['dismissible', 'not-dismissible', 'dry-run', 'json'];

function parse(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) positional.push(arg);
    else if (BOOLEANS.includes(arg.slice(2))) flags[arg.slice(2)] = true;
    else flags[arg.slice(2)] = argv[++i];
  }
  return { command: positional[0], rawId: positional[1], flags };
}

const csv = (value) =>
  value
    ? value
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : undefined;

function dismissible(flags) {
  if (flags['not-dismissible']) return false;
  if (flags.dismissible) return true;
  return undefined;
}

function content(flags) {
  return Object.fromEntries(
    Object.entries({
      severity: flags.severity,
      title: flags.title,
      message: flags.message,
      paths: csv(flags.paths),
      domains: csv(flags.domains),
      dismissible: dismissible(flags),
    }).filter(([, v]) => v !== undefined)
  );
}

function format(alert) {
  const now = new Date();
  const state =
    new Date(alert.endsAt) <= now
      ? 'ended'
      : new Date(alert.startsAt) > now
      ? `starts ${alert.startsAt}`
      : 'active';
  return [
    `#${alert.id} [${alert.severity}] ${alert.title} (${state})`,
    alert.message ? `  ${alert.message}` : null,
    `  paths: ${alert.paths.length ? alert.paths.join(' ') : 'every page'}  domains: ${alert.domains.join(',')}`,
    `  ends: ${alert.endsAt}  dismissible: ${alert.dismissible}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function alertId(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error('Pass the alert id: <command> <id>');
  return n;
}

/** `call` is the API client; injectable so a test can show `--dry-run` never reaches it. */
export async function main(argv, call = trpcCall) {
  const { command, rawId, flags } = parse(argv);
  if (command !== 'active' && !flags['dry-run']) requireApiKey();

  const mutate = async (procedure, input) => {
    if (flags['dry-run']) {
      console.log(`[dry-run] ${API_URL} ${procedure}\n${JSON.stringify(input, null, 2)}`);
      return;
    }
    const result = await call(procedure, input);
    console.log(flags.json ? JSON.stringify(result, null, 2) : format(result));
  };

  switch (command) {
    case 'list': {
      const alerts = await call('siteAlerts.list', undefined, 'GET');
      if (flags.json) console.log(JSON.stringify(alerts, null, 2));
      else console.log(alerts.length ? alerts.map(format).join('\n\n') : 'No site alerts.');
      return;
    }
    case 'active': {
      const payload = await call('siteAlerts.getActive', {}, 'GET');
      if (flags.json) console.log(JSON.stringify(payload, null, 2));
      else
        console.log(
          `version ${payload.version}\n\n${
            payload.alerts.length ? payload.alerts.map(format).join('\n\n') : 'No active alerts.'
          }`
        );
      return;
    }
    case 'post': {
      const hours = Number(flags.hours);
      if (!flags.title || !(hours > 0)) throw new Error('post needs --title and --hours');
      const start = flags.starts ? new Date(flags.starts) : new Date();
      if (Number.isNaN(start.getTime())) throw new Error('--starts is not a date');
      return mutate('siteAlerts.post', {
        severity: 'warning',
        ...content(flags),
        ...(flags.starts ? { startsAt: start.toISOString() } : {}),
        endsAt: new Date(start.getTime() + hours * 3_600_000).toISOString(),
      });
    }
    case 'edit':
      return mutate('siteAlerts.edit', { id: alertId(rawId), ...content(flags) });
    case 'extend': {
      const minutes = flags.minutes ? Number(flags.minutes) : Number(flags.hours) * 60;
      if (!(minutes > 0)) throw new Error('extend needs --minutes or --hours');
      return mutate('siteAlerts.extend', { id: alertId(rawId), minutes: Math.round(minutes) });
    }
    case 'end':
      return mutate('siteAlerts.end', { id: alertId(rawId) });
    default:
      console.log(
        'Usage: node .claude/skills/site-alert/site-alert.mjs <list|active|post|edit|extend|end> [id] [options]'
      );
      if (command) throw new Error(`Unknown command: ${command}`);
  }
}

if (isMain(import.meta.url)) run(() => main(process.argv.slice(2)));
