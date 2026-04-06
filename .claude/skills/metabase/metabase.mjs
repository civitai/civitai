#!/usr/bin/env node

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
  console.log(`Question created successfully!`);
  console.log(`  ID: ${card.id}`);
  console.log(`  Name: ${card.name}`);
  console.log(`  URL: ${METABASE_URL}/question/${card.id}`);
  if (Object.keys(templateTags).length > 0) {
    console.log(`  Variables: ${Object.keys(templateTags).join(', ')}`);
  }
  return card;
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

  const added = [];
  for (let i = 0; i < cardIds.length; i++) {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const result = await api('POST', `/dashboard/${dashId}/cards`, {
      cardId: cardIds[i],
    });

    // Position the card via PUT
    const dashcardId = result.id;
    added.push({
      id: dashcardId,
      card_id: cardIds[i],
      row: maxY + row * cardHeight,
      col: col * cardWidth,
      size_x: cardWidth,
      size_y: cardHeight,
    });
  }

  // Update layout positions in bulk
  if (added.length > 0) {
    // Re-fetch the full dashboard to get all dashcard data
    const fullDash = await api('GET', `/dashboard/${dashId}`);
    const allCards = fullDash.dashcards.map(dc => {
      const override = added.find(a => a.id === dc.id);
      if (override) {
        return { ...dc, row: override.row, col: override.col, size_x: override.size_x, size_y: override.size_y };
      }
      return dc;
    });
    await api('PUT', `/dashboard/${dashId}`, { dashcards: allCards });
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

async function updateQuestion(opts) {
  const { id, display, visualization } = opts;
  const cardId = parseInt(id, 10);
  if (!cardId) {
    console.error('Usage: update-question --id <id> [--display <type>] [--visualization \'{"key":"value"}\']');
    process.exit(1);
  }

  const body = {};
  if (display) body.display = display;
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
  const tags = nativeQuery?.['template-tags'] || {};
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
  const tags = nativeQuery?.['template-tags'] || {};
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

// Parse remaining args into key-value opts
function parseOpts(args) {
  const opts = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    }
  }
  return opts;
}

const opts = parseOpts(args);

const commands = {
  'run-query': runQuery,
  'create-question': createQuestion,
  'update-question': updateQuestion,
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
