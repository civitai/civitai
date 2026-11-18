// Reading and validating ports/manifest.json. The manifest is hand-written; nothing generates it.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

export const MANIFEST = 'ports/manifest.json';
export const SCHEMA = 'ports/manifest.schema.json';

// Where a flag key must be declared for the manifest to name it.
export const FLAG_SOURCES = [
  'src/server/flipt/client.ts',
  'src/server/services/feature-flags.service.ts',
];

const SOAK_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export const serviceDir = (service) => `apps/${service}`;

export function readJson(root, rel) {
  return JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
}

/** JSON Schema errors as `path: message` strings. */
export function schemaErrors(manifest, schema) {
  const Ajv = require('ajv');
  // strictTypes off: the status rules' `then` branches narrow properties without restating `type`.
  const ajv = new Ajv({ allErrors: true, strict: true, strictTypes: false, allowUnionTypes: true });
  const validate = ajv.compile(schema);
  if (validate(manifest)) return [];
  return validate.errors.map((e) => `${e.instancePath || '/'}: ${e.message}`);
}

const isDir = (abs) => {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
};

/** Non-test .go files under `dirAbs`, recursively. */
function goSources(dirAbs) {
  if (!isDir(dirAbs)) return [];
  return readdirSync(dirAbs, { recursive: true })
    .map(String)
    .filter(
      (f) => f.endsWith('.go') && !f.endsWith('_test.go') && !f.split(path.sep).includes('vendor')
    )
    .map((f) => path.join(dirAbs, f));
}

/**
 * A Go service's endpoint label values: the string constants its `Endpoints` slice
 * (`var Endpoints = []string{...}`) names, resolved from the service's non-test source.
 * Returns `{ values: Set, error }`; `error` is set when the slice or a constant in it is missing.
 */
export function goEndpointLabels(root, service) {
  const consts = new Map();
  let list = null;
  for (const file of goSources(path.join(root, serviceDir(service)))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^\s*(?:const\s+)?([A-Za-z_]\w*)\s*=\s*"([^"\\]*)"/gm)) {
      if (!consts.has(m[1])) consts.set(m[1], new Set());
      consts.get(m[1]).add(m[2]);
    }
    const l = /^var Endpoints = \[\]string\{([^}]*)\}/m.exec(text);
    if (l) list = l[1];
  }
  if (list === null)
    return {
      values: new Set(),
      error: `no \`var Endpoints = []string{...}\` in ${serviceDir(service)}`,
    };
  const values = new Set();
  for (const ref of list
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)) {
    const found = consts.get(ref.split('.').pop());
    if (!found || found.size !== 1)
      return {
        values,
        error: `Endpoints entry ${ref} is not one string constant in ${serviceDir(service)}`,
      };
    values.add([...found][0]);
  }
  return { values, error: null };
}

/** The manifest's dates (`{ field, value }`), for the no-future-date check. */
function datesOf(port) {
  return [
    ['soak.startedAt', port.soak?.startedAt],
    ['soak.signedOffAt', port.soak?.signedOffAt],
    ['nodeDeletion.signedOffAt', port.nodeDeletion?.signedOffAt],
  ].filter(([, value]) => typeof value === 'string');
}

/**
 * The checks a JSON Schema cannot express. Assumes the manifest passed the schema.
 * `now` (ms) is injectable for tests. A date may be at most one day past today (UTC), so a date
 * written in a timezone ahead of UTC is not rejected.
 */
export function semanticErrors(root, manifest, flagSources = FLAG_SOURCES, now = Date.now()) {
  const errors = [];
  const latest = now + DAY_MS;
  const labels = new Map();
  const labelOwner = new Map();
  const seen = new Set();
  const flagText = flagSources
    .filter((f) => existsSync(path.join(root, f)))
    .map((f) => readFileSync(path.join(root, f), 'utf8'))
    .join('\n');
  for (const port of manifest.ports) {
    const at = `port ${port.id}`;
    if (seen.has(port.id)) errors.push(`${at}: duplicate id`);
    seen.add(port.id);
    const dir = serviceDir(port.service);
    if (port.nodeEntry && !existsSync(path.join(root, port.nodeEntry.file)))
      errors.push(`${at}: nodeEntry.file ${port.nodeEntry.file} does not exist`);
    for (const f of port.goHandler) {
      if (!f.startsWith(`${dir}/`)) errors.push(`${at}: goHandler ${f} is outside ${dir}`);
      else if (!existsSync(path.join(root, f))) errors.push(`${at}: goHandler ${f} does not exist`);
    }
    for (const r of port.goRoots ?? []) {
      if (r !== dir && !r.startsWith(`${dir}/`))
        errors.push(`${at}: goRoots ${r} is outside ${dir}`);
      else if (!isDir(path.join(root, r))) errors.push(`${at}: goRoots ${r} is not a directory`);
    }
    for (const [kind, key] of Object.entries(port.flags)) {
      if (key === null) continue;
      if (!flagText.includes(`'${key}'`))
        errors.push(`${at}: flags.${kind} '${key}' is not declared in ${flagSources.join(' or ')}`);
    }
    if (!labels.has(port.service)) labels.set(port.service, goEndpointLabels(root, port.service));
    const { values, error } = labels.get(port.service);
    if (error) errors.push(`${at}: metricEndpoint: ${error}`);
    else if (!values.has(port.metricEndpoint))
      errors.push(
        `${at}: metricEndpoint '${port.metricEndpoint}' is not one of ${
          port.service
        }'s endpoint labels (${[...values].join(', ')})`
      );
    const labelKey = `${port.service} ${port.metricEndpoint}`;
    if (labelOwner.has(labelKey))
      errors.push(
        `${at}: metricEndpoint '${port.metricEndpoint}' is also port ${labelOwner.get(labelKey)}'s`
      );
    else labelOwner.set(labelKey, port.id);
    for (const [field, value] of datesOf(port))
      if (!(Date.parse(value) <= latest))
        errors.push(`${at}: ${field} ${value} is in the future or does not parse as a date`);
    const s = port.soak;
    if (s?.signedOffAt) {
      const days = (Date.parse(s.signedOffAt) - Date.parse(s.startedAt)) / DAY_MS;
      if (!(days >= SOAK_DAYS))
        errors.push(
          `${at}: soak signed off ${s.signedOffAt}, ${days} days after it started (${s.startedAt}); the gate is ${SOAK_DAYS} days`
        );
    }
  }
  return errors;
}
