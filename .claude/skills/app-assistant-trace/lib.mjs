/**
 * The app-assistant-trace skill's CLI, as pure functions plus one `run` that takes its fetch, env and
 * output streams, so the tests drive it without a network. `trace.mjs` is the entry point.
 *
 * Reads the moderator trace API (`/api/mod/apps/assistant-trace/*`, GET only) with a moderator's
 * full-access API key. The key is sent as a bearer header and is never printed.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const skillDir = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_API_URL = 'https://civitai.com';
export const ROUTE = '/api/mod/apps/assistant-trace';

/** Exit statuses: 0 ok, 1 the API (or the network) refused, 2 the command line was wrong. */
export const EXIT = { ok: 0, api: 1, usage: 2 };

export const USAGE = `Usage: node .claude/skills/app-assistant-trace/trace.mjs <command> [args]

  request <publishRequestId>                              one submission's trace
  app <slug> [--limit N] [--cursor <publishRequestId>]    every submission of an app
  transcript <publishRequestId> <conversationId> [--tool-output-chars N]
                                                          one frozen chat, turn by turn
  signals [--from <ISO date>] [--to <ISO date>]           signals in aggregate, per week

Needs CIVITAI_API_KEY (a moderator's full-access key) in .claude/skills/app-assistant-trace/.env.
Prints the API's JSON to stdout.`;

/** `KEY=value` lines of the skill's own `.env` (comments and blanks ignored). Missing file: {}. */
export function readEnvFile(path = resolve(skillDir, '.env')) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const values = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return values;
}

/** The config, the process env winning over the skill's `.env`. */
export function loadConfig(env = process.env, file = readEnvFile()) {
  const apiKey = env.CIVITAI_API_KEY || file.CIVITAI_API_KEY || '';
  const apiUrl = (env.CIVITAI_API_URL || file.CIVITAI_API_URL || DEFAULT_API_URL).replace(
    /\/+$/,
    ''
  );
  return { apiKey, apiUrl };
}

const FLAGS = {
  app: { '--limit': 'limit', '--cursor': 'cursor' },
  transcript: { '--tool-output-chars': 'toolOutputChars' },
  signals: { '--from': 'from', '--to': 'to' },
  request: {},
};
const POSITIONALS = {
  request: ['publishRequestId'],
  app: ['slug'],
  transcript: ['publishRequestId', 'conversationId'],
  signals: [],
};

export class UsageError extends Error {}

/** `argv` (no node/script) as `{ command, query }`, or a UsageError naming what is wrong. */
export function parseCommand(argv) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h')
    throw new UsageError('');
  if (!(command in POSITIONALS)) throw new UsageError(`Unknown command: ${command}`);
  const flags = FLAGS[command];
  const positionals = [];
  const query = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.includes('=')
        ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
        : [arg, undefined];
      const key = flags[name];
      if (!key) throw new UsageError(`Unknown option for ${command}: ${name}`);
      const value = inline ?? rest[++i];
      if (value === undefined || value === '' || value.startsWith('--'))
        throw new UsageError(`${name} needs a value`);
      query[key] = value;
    } else positionals.push(arg);
  }
  const names = POSITIONALS[command];
  if (positionals.length !== names.length)
    throw new UsageError(
      `${command} takes ${names.length ? names.map((n) => `<${n}>`).join(' ') : 'no arguments'}`
    );
  names.forEach((name, i) => (query[name] = positionals[i]));
  for (const key of ['limit', 'toolOutputChars'])
    if (key in query && !/^\d+$/.test(query[key]))
      throw new UsageError(
        `--${key === 'limit' ? 'limit' : 'tool-output-chars'} must be a whole number`
      );
  for (const key of ['from', 'to'])
    if (key in query && Number.isNaN(Date.parse(query[key])))
      throw new UsageError(`--${key} must be a date (ISO-8601)`);
  return { command, query };
}

/** The URL a parsed command reads. */
export function requestUrl(apiUrl, { command, query }) {
  const params = new URLSearchParams(query);
  const search = params.toString();
  return `${apiUrl}${ROUTE}/${command}${search ? `?${search}` : ''}`;
}

/** Runs one command. Returns the exit status; writes JSON to stdout, problems to stderr. */
export async function run(
  argv,
  {
    fetch = globalThis.fetch,
    env = process.env,
    file,
    stdout = process.stdout,
    stderr = process.stderr,
  } = {}
) {
  let parsed;
  try {
    parsed = parseCommand(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    stderr.write(`${error.message ? `${error.message}\n\n` : ''}${USAGE}\n`);
    return EXIT.usage;
  }
  const { apiKey, apiUrl } = loadConfig(env, file ?? readEnvFile());
  if (!apiKey) {
    stderr.write(
      'CIVITAI_API_KEY is not set: put a moderator’s full-access key in .claude/skills/app-assistant-trace/.env (see .env.example).\n'
    );
    return EXIT.usage;
  }
  const url = requestUrl(apiUrl, parsed);
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    });
  } catch (error) {
    stderr.write(
      `${JSON.stringify({
        status: null,
        code: 'NETWORK',
        error: String(error?.message ?? error),
      })}\n`
    );
    return EXIT.api;
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    stderr.write(
      `${JSON.stringify({
        status: response.status,
        code: body?.code ?? null,
        error: body?.error ?? body?.message ?? (text.slice(0, 300) || response.statusText),
      })}\n`
    );
    return EXIT.api;
  }
  stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  return EXIT.ok;
}
