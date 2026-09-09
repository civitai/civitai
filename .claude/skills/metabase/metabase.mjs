#!/usr/bin/env node
import { parseOpts } from './parse-opts.mjs';

/**
 * Metabase Skill — create questions, dashboards, and manage public sharing
 *
 * Commands:
 *   run-query       Run an ad-hoc native query (no saved card)
 *   create-question Create a saved question (card) with optional template variables
 *   create-dashboard Create a dashboard
 *   add-to-dashboard Add saved questions to a dashboard
 *   share           Generate a public link for a question or dashboard
 *   list            List questions/dashboards in a collection
 *   search          Search for questions/dashboards by name
 *   get             Get details of a question or dashboard
 *   set-dropdown     Configure a template tag variable as a dropdown list
 *   set-date-picker  Configure a template tag variable as a date picker
 *   set-parameters   Set all parameters on a question (full JSON)
 *   list-collections List all collections
 *   list-databases  List all databases
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillDir = __dirname;
const projectRoot = resolve(__dirname, '../../..');

// ── Config ────────────────────────────────────────────────────────────────────

function loadEnv() {
  const envFiles = [
    resolve(skillDir, '.env'),
    resolve(projectRoot, '.env'),
  ];
  for (const envPath of envFiles) {
    try {
      const envContent = readFileSync(envPath, 'utf-8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex);
        const value = trimmed.slice(eqIndex + 1);
        if (!process.env[key]) process.env[key] = value;
      }
    } catch (_) { /* file not found */ }
  }
}

loadEnv();

const METABASE_URL = (process.env.METABASE_URL || '').replace(/\/+$/, '');
const METABASE_API_KEY = process.env.METABASE_API_KEY || '';

if (!METABASE_URL || !METABASE_API_KEY) {
  console.error('Error: METABASE_URL and METABASE_API_KEY must be set');
  process.exit(1);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const url = `${METABASE_URL}/api${path}`;
  const opts = {
    method,
    headers: {
      'x-api-key': METABASE_API_KEY,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  if (!res.ok) {
    console.error(`API Error ${res.status} ${method} ${path}:`);
    console.error(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function runQuery(opts) {
  const { database, query, timeout } = opts;
  const dbId = parseInt(database, 10);
  if (!dbId || !query) {
    console.error('Usage: run-query --database <id> --query "SQL"');
    process.exit(1);
  }

  const start = Date.now();
  const result = await api('POST', '/dataset', {
    database: dbId,
    type: 'native',
    native: { query, 'template-tags': {} },
  });
  const elapsed = Date.now() - start;

  if (result.status === 'failed') {
    console.error('Query failed:', result.error);
    process.exit(1);
  }

  const cols = result.data.cols.map(c => c.name);
  const rows = result.data.rows;
  console.log('Columns:', cols.join(', '));
  console.log('─'.repeat(60));
  for (const row of rows) {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    console.log(obj);
  }
  console.error(`\n${rows.length} row(s) in ${elapsed}ms`);
}

async function createQuestion(opts) {
  const { name, database, query, collection, description, variables } = opts;
  const dbId = parseInt(database, 10);
  if (!name || !dbId || !query) {
    console.error('Usage: create-question --name "Name" --database <id> --query "SQL" [--collection <id>] [--description "..."] [--variables \'{"name":{"type":"text","display-name":"Name"}}\']');
    process.exit(1);
  }

  // Parse template tags from variables JSON or auto-detect {{variable}} patterns
  let templateTags = {};
  if (variables) {
    try {
      templateTags = JSON.parse(variables);
    } catch (e) {
      console.error('Error: --variables must be valid JSON');
      process.exit(1);
    }
  } else {
    // Auto-detect {{variable}} in query
    const matches = query.matchAll(/\{\{(\w+)\}\}/g);
    for (const m of matches) {
      const varName = m[1];
      templateTags[varName] = {
        id: varName,
        name: varName,
        'display-name': varName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        type: 'text',
      };
    }
  }

  const body = {
    name,
    dataset_query: {
      database: dbId,
      type: 'native',
      native: {
        query,
        'template-tags': templateTags,
      },
    },
    display: 'table',
    visualization_settings: {},
  };
  if (collection) body.collection_id = parseInt(collection, 10);
  if (description) body.description = description;

  // Build top-level parameters for dropdowns/date pickers if provided
  if (opts.parameters) {
    try {
      body.parameters = JSON.parse(opts.parameters);
    } catch (e) {
      console.error('Error: --parameters must be valid JSON');
      process.exit(1);
    }
  }

  const card = await api('POST', '/card', body);

  // Read the card back rather than trusting the create. The API reports success for a card carrying no
  // query at all, and such a card renders blank — indistinguishable from a permissions problem, which is
  // how it was read the first time. The server rewrites the legacy `dataset_query.native.query` we post
  // into a `stages[0].native` string, so both shapes are accepted here.
  const stored = await readCard(card.id);
  if (stored === null) {
    console.error(`Card ${card.id} was created but could not be read back, so it is unverified.`);
    console.error(`  Check it: ${METABASE_URL}/question/${card.id}`);
    process.exit(1);
  }
  const storedQuery = storedNativeQuery(stored);
  if (storedQuery !== query) {
    console.error(`Card ${card.id} was created but does not carry the SQL that was sent.`);
    console.error(`  stored: ${storedQuery === undefined ? '(no query at all)' : JSON.stringify(storedQuery)}`);
    console.error(`  sent:   ${JSON.stringify(query)}`);
    console.error(`  URL: ${METABASE_URL}/question/${card.id}`);
    process.exit(1);
  }

  console.log(`Question created successfully!`);
  console.log(`  ID: ${card.id}`);
  console.log(`  Name: ${card.name}`);
  console.log(`  URL: ${METABASE_URL}/question/${card.id}`);
  console.log(`  Verified: the stored query matches what was sent`);
  if (Object.keys(templateTags).length > 0) {
    console.log(`  Variables: ${Object.keys(templateTags).join(', ')}`);
  }
  return card;
}

// Read a card without `api()`'s exit-on-failure: a GET that fails must not be reported as a create that
// failed, since the card exists either way and the difference decides what the operator does next.
async function readCard(id) {
  try {
    const res = await fetch(`${METABASE_URL}/api/card/${id}`, {
      headers: { 'x-api-key': METABASE_API_KEY },
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// The SQL a saved card actually carries, in either shape the API returns. Anything that is not a string —
// the boolean a degraded flag value used to produce, most of all — comes back undefined.
function storedNativeQuery(card) {
  const stage = card?.dataset_query?.native ?? card?.dataset_query?.stages?.[0];
  const sql = typeof stage === 'string' ? stage : (stage?.query ?? stage?.native);
  return typeof sql === 'string' ? sql : undefined;
}

async function createDashboard(opts) {
  const { name, collection, description } = opts;
  if (!name) {
    console.error('Usage: create-dashboard --name "Name" [--collection <id>] [--description "..."]');
    process.exit(1);
  }

  const body = { name, parameters: [] };
  if (collection) body.collection_id = parseInt(collection, 10);
  if (description) body.description = description;

  const dashboard = await api('POST', '/dashboard', body);
  console.log(`Dashboard created successfully!`);
  console.log(`  ID: ${dashboard.id}`);
  console.log(`  Name: ${dashboard.name}`);
  console.log(`  URL: ${METABASE_URL}/dashboard/${dashboard.id}`);
  return dashboard;
}

async function addToDashboard(opts) {
  const { dashboard, cards, cols: colCount } = opts;
  const dashId = parseInt(dashboard, 10);
  if (!dashId || !cards) {
    console.error('Usage: add-to-dashboard --dashboard <id> --cards "1,2,3" [--cols <cards-per-row>]');
    process.exit(1);
  }

  const cardIds = cards.split(',').map(id => parseInt(id.trim(), 10));
  const perRow = parseInt(colCount, 10) || 2;
  const cardWidth = Math.floor(24 / perRow);  // Metabase uses 24-column grid
  const cardHeight = 8;

  // Get existing cards on dashboard to avoid position conflicts
  const existing = await api('GET', `/dashboard/${dashId}`);
  const existingCards = existing.dashcards || [];
  let maxY = 0;
  for (const dc of existingCards) {
    const bottom = (dc.row || 0) + (dc.size_y || 0);
    if (bottom > maxY) maxY = bottom;
  }

  // Dashcards are created by PUTting the whole `dashcards` array, not by POSTing to
  // /dashboard/:id/cards -- that endpoint is gone and 404s. A new card is an entry with a
  // negative placeholder id; the server assigns the real one.
  const added = cardIds.map((cardId, i) => ({
    id: -1 - i,
    card_id: cardId,
    row: maxY + Math.floor(i / perRow) * cardHeight,
    col: (i % perRow) * cardWidth,
    size_x: cardWidth,
    size_y: cardHeight,
    parameter_mappings: [],
    visualization_settings: {},
  }));

  const saved = await api('PUT', `/dashboard/${dashId}`, {
    dashcards: [...existingCards, ...added],
  });

  // Read back rather than trust the write: a dashboard that saved no cards renders empty,
  // which looks the same as a permissions problem.
  const present = new Set((saved.dashcards || []).map((dc) => dc.card_id));
  const missing = cardIds.filter((id) => !present.has(id));
  if (missing.length > 0) {
    console.error(`Dashboard ${dashId} did not take card(s): ${missing.join(', ')}`);
    console.error(`  URL: ${METABASE_URL}/dashboard/${dashId}`);
    process.exit(1);
  }

  console.log(`Added ${cardIds.length} card(s) to dashboard ${dashId}`);
  for (const a of added) {
    console.log(`  Card ${a.card_id} → position (${a.col}, ${a.row}) size ${a.size_x}x${a.size_y}`);
  }
  console.log(`  URL: ${METABASE_URL}/dashboard/${dashId}`);
}

async function share(opts) {
  const { type, id } = opts;
  const entityId = parseInt(id, 10);
  if (!type || !entityId || !['question', 'dashboard'].includes(type)) {
    console.error('Usage: share --type <question|dashboard> --id <id>');
    process.exit(1);
  }

  const endpoint = type === 'question' ? 'card' : 'dashboard';
  const result = await api('POST', `/${endpoint}/${entityId}/public_link`);
  const publicUrl = type === 'question'
    ? `${METABASE_URL}/public/question/${result.uuid}`
    : `${METABASE_URL}/public/dashboard/${result.uuid}`;

  console.log(`Public link created!`);
  console.log(`  UUID: ${result.uuid}`);
  console.log(`  URL: ${publicUrl}`);
}

async function listItems(opts) {
  const { collection, type } = opts;
  const colId = collection || 'root';
  const params = new URLSearchParams();
  if (type) params.set('models', type === 'question' ? 'card' : type);

  const items = await api('GET', `/collection/${colId}/items?${params}`);
  const data = items.data || items;

  if (data.length === 0) {
    console.log('(no items found)');
    return;
  }

  for (const item of data) {
    const kind = item.model || '?';
    console.log(`  [${kind}] ID:${item.id} — ${item.name}`);
  }
  console.log(`\n${data.length} item(s)`);
}

async function searchItems(opts) {
  const { query, type } = opts;
  if (!query) {
    console.error('Usage: search --query "search term" [--type question|dashboard]');
    process.exit(1);
  }

  const params = new URLSearchParams({ q: query });
  if (type) params.set('models', type === 'question' ? 'card' : type);

  const results = await api('GET', `/search?${params}`);
  const data = results.data || results;

  if (data.length === 0) {
    console.log('(no results)');
    return;
  }

  for (const item of data) {
    const kind = item.model || '?';
    const colName = item.collection?.name || 'root';
    console.log(`  [${kind}] ID:${item.id} — ${item.name}  (in: ${colName})`);
  }
  console.log(`\n${data.length} result(s)`);
}

async function getItem(opts) {
  const { type, id } = opts;
  const entityId = parseInt(id, 10);
  if (!type || !entityId) {
    console.error('Usage: get --type <question|dashboard|collection> --id <id>');
    process.exit(1);
  }

  const endpoint = type === 'question' ? 'card' : type;
  const data = await api('GET', `/${endpoint}/${entityId}`);
  console.log(JSON.stringify(data, null, 2));
}

async function listCollections() {
  const cols = await api('GET', '/collection');
  for (const c of cols) {
    if (c.is_personal || c.archived) continue;
    const parent = c.parent_id ? `  (parent: ${c.parent_id})` : '';
    console.log(`  ID:${c.id} — ${c.name}${parent}`);
  }
}

async function listDatabases() {
  const result = await api('GET', '/database');
  const dbs = result.data || result;
  for (const db of dbs) {
    console.log(`  ID:${db.id} — ${db.name} (${db.engine})`);
  }
}

async function runCard(opts) {
  const { id, params } = opts;
  const cardId = parseInt(id, 10);
  if (!cardId) {
    console.error('Usage: run-card --id <id> [--params \'{"from":"2026-09-09","to":"2026-09-10"}\']');
    process.exit(1);
  }

  const card = await api('GET', `/card/${cardId}`);
  // MBQL 4 stores template-tags as an object keyed by name; MBQL 5 (what a GET returns
  // today) stores the same records as an array. Normalise to the keyed form.
  const rawTags =
    card.dataset_query?.native?.['template-tags'] ??
    card.dataset_query?.stages?.[0]?.['template-tags'] ??
    {};
  const tags = Array.isArray(rawTags)
    ? Object.fromEntries(rawTags.map((t) => [t.name, t]))
    : rawTags;

  let values = {};
  if (params) {
    try {
      values = JSON.parse(params);
    } catch (e) {
      console.error('Error: --params must be valid JSON');
      process.exit(1);
    }
  }

  const parameters = Object.entries(values).map(([name, value]) => {
    const tag = tags[name];
    if (!tag) {
      console.error(`Error: question ${cardId} has no {{${name}}} variable`);
      process.exit(1);
    }
    return {
      id: tag.id,
      type: tag.type === 'date' ? 'date/single' : `category`,
      value,
      target: ['variable', ['template-tag', name]],
    };
  });

  const result = await api('POST', `/card/${cardId}/query`, { parameters });
  if (result.status && result.status !== 'completed') {
    console.error(`Query ${result.status}: ${result.error || 'unknown error'}`);
    process.exit(1);
  }
  const cols = result.data.cols.map((c) => c.display_name || c.name);
  console.log(`Columns: ${cols.join(', ')}`);
  console.log('─'.repeat(60));
  for (const row of result.data.rows) {
    console.log(JSON.stringify(Object.fromEntries(cols.map((c, i) => [c, row[i]])), null, 2));
  }
  console.log(`\n${result.data.rows.length} row(s)`);
}

async function updateQuestion(opts) {
  const { id, display, visualization, query, description, archived, variables } = opts;
  const cardId = parseInt(id, 10);
  if (!cardId) {
    console.error('Usage: update-question --id <id> [--display <type>] [--visualization \'{"key":"value"}\'] [--query "SQL"] [--variables \'{...}\'] [--description "..."] [--archived true|false]');
    process.exit(1);
  }

  const body = {};
  if (display) body.display = display;
  if (description !== undefined) body.description = description;
  if (archived !== undefined) body.archived = archived === 'true' || archived === true;
  if (query) {
    // A card's dataset_query must be sent whole, so start from the stored one and
    // swap the SQL. Template tags are rebuilt because a changed query may add or
    // drop {{variables}}, and Metabase drops a parameter whose tag disappears.
    const existing = await api('GET', `/card/${cardId}`);
    // A GET returns MBQL 5 (`lib/type` + `stages`), but PUT rejects a body that mixes
    // that with `type`/`native` — so rebuild the MBQL 4 shape create-question sends
    // rather than spreading what came back. Read the old tags from either shape.
    const oldNative =
      existing.dataset_query?.native ?? existing.dataset_query?.stages?.[0] ?? {};
    let templateTags = oldNative['template-tags'] || oldNative.template_tags || {};
    if (variables) {
      try {
        templateTags = JSON.parse(variables);
      } catch (e) {
        console.error('Error: --variables must be valid JSON');
        process.exit(1);
      }
    }
    body.dataset_query = {
      database: existing.database_id ?? existing.dataset_query?.database,
      type: 'native',
      native: { query, 'template-tags': templateTags },
    };
  }
  if (visualization) {
    try {
      body.visualization_settings = JSON.parse(visualization);
    } catch (e) {
      console.error('Error: --visualization must be valid JSON');
      process.exit(1);
    }
  }

  const card = await api('PUT', `/card/${cardId}`, body);
  console.log(`Question ${cardId} updated`);
  console.log(`  Display: ${card.display}`);
  if (query) {
    const stored =
      card.dataset_query?.native?.query ?? card.dataset_query?.stages?.[0]?.native;
    if (stored !== query) {
      console.error('Error: the stored query does not match what was sent');
      process.exit(1);
    }
    console.log('  Verified: the stored query matches what was sent');
  }
  if (body.archived !== undefined) console.log(`  Archived: ${card.archived}`);
  console.log(`  URL: ${METABASE_URL}/question/${cardId}`);
}

async function addDashboardFilter(opts) {
  const { dashboard, filtername, filtertype, slug, target } = opts;
  const dashId = parseInt(dashboard, 10);
  if (!dashId || !filtername || !filtertype) {
    console.error('Usage: add-dashboard-filter --dashboard <id> --filtername "Name" --filtertype "string/=" [--slug "slug"] [--target \'[{"card_id":1,"parameter_id":"...","target":["variable",["template-tag","var"]]}]\']');
    process.exit(1);
  }

  // Get existing dashboard
  const dash = await api('GET', `/dashboard/${dashId}`);
  const params = dash.parameters || [];

  const paramId = slug || filtername.toLowerCase().replace(/\s+/g, '_');
  params.push({
    id: paramId,
    name: filtername,
    slug: paramId,
    type: filtertype,
  });

  const updateBody = { parameters: params };

  // If target mappings provided, wire them up to dashcards
  if (target) {
    try {
      const mappings = JSON.parse(target);
      const dashcards = dash.dashcards.map(dc => {
        const mapping = mappings.find(m => m.card_id === dc.card_id);
        if (mapping) {
          const existing = dc.parameter_mappings || [];
          existing.push({
            parameter_id: paramId,
            card_id: dc.card_id,
            target: mapping.target,
          });
          return { ...dc, parameter_mappings: existing };
        }
        return dc;
      });
      updateBody.dashcards = dashcards;
    } catch (e) {
      console.error('Error: --target must be valid JSON');
      process.exit(1);
    }
  }

  await api('PUT', `/dashboard/${dashId}`, updateBody);
  console.log(`Filter "${filtername}" added to dashboard ${dashId}`);
  console.log(`  Parameter ID: ${paramId}`);
  console.log(`  Type: ${filtertype}`);
}

async function setDropdown(opts) {
  const { id, variable, values, default: defaultVal, required } = opts;
  const cardId = parseInt(id, 10);
  if (!cardId || !variable || !values) {
    console.error('Usage: set-dropdown --id <card-id> --variable <name> --values "val1,val2,val3" [--default val1] [--required]');
    process.exit(1);
  }

  const card = await api('GET', `/card/${cardId}`);
  const existingParams = card.parameters || [];

  // Find the template tag to get its ID
  const nativeQuery = card.dataset_query?.native || card.dataset_query?.stages?.[0];
  const rawTags = nativeQuery?.['template-tags'] || {};
  // MBQL 5 returns template-tags as an array of records, MBQL 4 as an object keyed by
  // name. Looking up by name on the array finds nothing and lists the indices as the
  // available tags, which reads as "that variable is missing" rather than "wrong shape".
  const tags = Array.isArray(rawTags)
    ? Object.fromEntries(rawTags.map((t) => [t.name, t]))
    : rawTags;
  const tag = tags[variable];
  if (!tag) {
    console.error(`Error: Template tag "${variable}" not found in question ${cardId}`);
    console.error(`  Available tags: ${Object.keys(tags).join(', ')}`);
    process.exit(1);
  }

  const paramId = tag.id;
  const valuesList = values.split(',').map(v => [v.trim()]);
  const defaultValue = defaultVal ? [defaultVal] : (tag.default || undefined);

  // Remove existing param for this variable if present
  const filtered = existingParams.filter(p => p.id !== paramId);

  filtered.push({
    slug: variable,
    values_query_type: 'list',
    default: defaultValue,
    name: tag['display-name'] || variable,
    isMultiSelect: false,
    type: 'string/=',
    values_source_type: 'static-list',
    id: paramId,
    target: ['variable', ['template-tag', variable]],
    values_source_config: { values: valuesList },
    required: required === true || required === 'true',
  });

  await api('PUT', `/card/${cardId}`, { parameters: filtered });
  console.log(`Dropdown set for "${variable}" on question ${cardId}`);
  console.log(`  Values: ${valuesList.map(v => v[0]).join(', ')}`);
  console.log(`  Default: ${defaultValue ? defaultValue[0] : '(none)'}`);
  console.log(`  URL: ${METABASE_URL}/question/${cardId}`);
}

async function setDatePicker(opts) {
  const { id, variable, default: defaultVal, required } = opts;
  const cardId = parseInt(id, 10);
  if (!cardId || !variable) {
    console.error('Usage: set-date-picker --id <card-id> --variable <name> [--default "2026-01-01"] [--required]');
    process.exit(1);
  }

  const card = await api('GET', `/card/${cardId}`);
  const existingParams = card.parameters || [];

  const nativeQuery = card.dataset_query?.native || card.dataset_query?.stages?.[0];
  const rawTags = nativeQuery?.['template-tags'] || {};
  // MBQL 5 returns template-tags as an array of records, MBQL 4 as an object keyed by
  // name. Looking up by name on the array finds nothing and lists the indices as the
  // available tags, which reads as "that variable is missing" rather than "wrong shape".
  const tags = Array.isArray(rawTags)
    ? Object.fromEntries(rawTags.map((t) => [t.name, t]))
    : rawTags;
  const tag = tags[variable];
  if (!tag) {
    console.error(`Error: Template tag "${variable}" not found in question ${cardId}`);
    console.error(`  Available tags: ${Object.keys(tags).join(', ')}`);
    process.exit(1);
  }

  const paramId = tag.id;
  const filtered = existingParams.filter(p => p.id !== paramId);

  filtered.push({
    id: paramId,
    type: 'date/single',
    target: ['variable', ['template-tag', variable]],
    name: tag['display-name'] || variable,
    slug: variable,
    default: defaultVal || tag.default || undefined,
    required: required === true || required === 'true',
    isMultiSelect: false,
  });

  await api('PUT', `/card/${cardId}`, { parameters: filtered });
  console.log(`Date picker set for "${variable}" on question ${cardId}`);
  console.log(`  Default: ${defaultVal || tag.default || '(none)'}`);
  console.log(`  URL: ${METABASE_URL}/question/${cardId}`);
}

async function setParameters(opts) {
  const { id, parameters } = opts;
  const cardId = parseInt(id, 10);
  if (!cardId || !parameters) {
    console.error('Usage: set-parameters --id <card-id> --parameters \'[{...}]\'');
    process.exit(1);
  }

  let params;
  try {
    params = JSON.parse(parameters);
  } catch (e) {
    console.error('Error: --parameters must be valid JSON array');
    process.exit(1);
  }

  const card = await api('PUT', `/card/${cardId}`, { parameters: params });
  console.log(`Parameters updated on question ${cardId}`);
  for (const p of card.parameters || []) {
    const src = p.values_source_type || p.type;
    const vals = p.values_source_config?.values;
    console.log(`  ${p.name}: ${src}${vals ? ` [${vals.map(v => v[0]).join(', ')}]` : ''} default=${JSON.stringify(p.default)}`);
  }
  console.log(`  URL: ${METABASE_URL}/question/${cardId}`);
}

// ── CLI parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

if (!command) {
  console.error(`Usage: node metabase.mjs <command> [options]

Commands:
  run-query            Run an ad-hoc SQL query
  create-question      Create a saved question (card)
  update-question      Update a question's display/visualization
  create-dashboard     Create a new dashboard
  add-to-dashboard     Add questions to a dashboard
  add-dashboard-filter Add a filter parameter to a dashboard
  set-dropdown         Make a template variable a dropdown list
  set-date-picker      Make a template variable a date picker
  set-parameters       Set all parameters on a question (full JSON)
  share                Generate a public link
  list                 List items in a collection
  search               Search for questions/dashboards
  get                  Get details of an item
  list-collections     List all collections
  list-databases       List all databases

Common Options:
  --database <id>      Database ID (3=ClickHouse, 2=Prod PG, 35=Buzz DB)
  --collection <id>    Collection ID to save into
  --json               JSON output`);
  process.exit(1);
}

let opts;
try {
  opts = parseOpts(args);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

const commands = {
  'run-query': runQuery,
  'create-question': createQuestion,
  'update-question': updateQuestion,
  'run-card': runCard,
  'create-dashboard': createDashboard,
  'add-to-dashboard': addToDashboard,
  'add-dashboard-filter': addDashboardFilter,
  'set-dropdown': setDropdown,
  'set-date-picker': setDatePicker,
  'set-parameters': setParameters,
  'share': share,
  'list': listItems,
  'search': searchItems,
  'get': getItem,
  'list-collections': listCollections,
  'list-databases': listDatabases,
};

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  console.error(`Available: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}

commands[command](opts);
