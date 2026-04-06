#!/usr/bin/env node
/**
 * BitDex Image Search Test Tool
 *
 * Query the image.getInfinite tRPC endpoint with any combination of filters,
 * matching what the frontend does from various pages on the site.
 *
 * Usage:
 *   node .claude/skills/bitdex-test/query.mjs [options]
 *
 * Options:
 *   --base-url <url>        Base URL (default: http://localhost:3000)
 *   --limit <n>             Number of results (default: 5)
 *   --sort <sort>           Sort: Newest, MostReactions, MostComments, MostCollected, Oldest
 *   --period <period>       Period: Day, Week, Month, Year, AllTime
 *   --types <types>         Comma-separated: image,video,audio
 *   --tags <ids>            Comma-separated tag IDs
 *   --tools <ids>           Comma-separated tool IDs
 *   --techniques <ids>      Comma-separated technique IDs
 *   --base-models <models>  Comma-separated base models (e.g., "SD 1.5,SDXL 1.0")
 *   --user-id <id>          Filter by user ID
 *   --username <name>       Filter by username
 *   --model-id <id>         Filter by model ID
 *   --model-version-id <id> Filter by model version ID
 *   --post-id <id>          Filter by post ID
 *   --remix-of <id>         Filter by remixOfId
 *   --remixes-only          Show only remixes
 *   --non-remixes-only      Show only originals
 *   --with-meta             Only images with metadata
 *   --from-platform         Only on-site images
 *   --nsfw <level>          Browsing level bitmask (default: 31 = all)
 *   --cursor <cursor>       Pagination cursor
 *   --raw                   Output full JSON response
 *   --json                  Output compressed JSON (for piping)
 */

const BASE_URL = getArg('--base-url') || 'http://localhost:3000';

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}
function hasFlag(flag) {
  return process.argv.includes(flag);
}
function getArrayArg(flag) {
  const val = getArg(flag);
  if (!val) return undefined;
  return val.split(',').map(s => s.trim());
}
function getNumArrayArg(flag) {
  const arr = getArrayArg(flag);
  if (!arr) return undefined;
  return arr.map(Number).filter(n => !isNaN(n));
}

async function query(input) {
  const encoded = encodeURIComponent(JSON.stringify({ json: input }));
  const url = `${BASE_URL}/api/trpc/image.getInfinite?input=${encoded}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    process.exit(1);
  }

  const data = await res.json();
  return data.result?.data?.json ?? data;
}

function formatImage(img, i) {
  const date = img.createdAt || img.sortAt;
  const dateStr = date ? new Date(date).toISOString().slice(0, 10) : '?';
  const type = img.type || '?';
  const nsfw = img.nsfwLevel ?? '?';
  const avail = img.availability || '?';
  const user = img.user?.username || `uid:${img.userId}`;
  const reactions = img.stats
    ? `❤${img.stats.heartCountAllTime} 👍${img.stats.likeCountAllTime} 😂${img.stats.laughCountAllTime} 😢${img.stats.cryCountAllTime} 💬${img.stats.commentCountAllTime} 📦${img.stats.collectedCountAllTime}`
    : `rxn:${img.reactionCount ?? '?'}`;
  const baseModel = img.baseModel || '-';
  const tags = img.tagIds?.length ? `tags:[${img.tagIds.slice(0, 5).join(',')}${img.tagIds.length > 5 ? '...' : ''}]` : '';
  const models = img.modelVersionIds?.length ? `mvIds:[${img.modelVersionIds.slice(0, 3).join(',')}${img.modelVersionIds.length > 3 ? '...' : ''}]` : '';
  const dims = img.metadata?.width && img.metadata?.height ? `${img.metadata.width}x${img.metadata.height}` : '';
  const blocked = img.blockedFor ? `BLOCKED:${img.blockedFor}` : '';
  const remix = img.remixOfId ? `remix:${img.remixOfId}` : '';
  const published = img.publishedAt ? '' : 'UNPUBLISHED';
  const meta = img.hasMeta ? 'meta' : 'no-meta';
  const onSite = img.onSite ? 'onsite' : '';
  const poi = img.poi ? 'POI' : '';
  const minor = img.minor ? 'MINOR' : '';

  const flags = [blocked, remix, published, poi, minor].filter(Boolean).join(' ');

  return `  ${String(i + 1).padStart(2)}. id:${img.id} | ${type} | ${dateStr} | nsfw:${nsfw} | ${avail} | ${baseModel} | ${user} | ${dims} | ${meta} ${onSite} | ${reactions} ${tags} ${models} ${flags}`.trimEnd();
}

async function main() {
  const input = {
    limit: parseInt(getArg('--limit') || '5', 10),
    sort: getArg('--sort') || 'Newest',
    period: getArg('--period') || 'AllTime',
    browsingLevel: parseInt(getArg('--nsfw') || '31', 10),
    useIndex: true,
    include: ['cosmetics', 'tagIds'],
  };

  // Optional filters
  const types = getArrayArg('--types');
  if (types) input.types = types;

  const tags = getNumArrayArg('--tags');
  if (tags) input.tags = tags;

  const tools = getNumArrayArg('--tools');
  if (tools) input.tools = tools;

  const techniques = getNumArrayArg('--techniques');
  if (techniques) input.techniques = techniques;

  const baseModels = getArrayArg('--base-models');
  if (baseModels) input.baseModels = baseModels;

  const userId = getArg('--user-id');
  if (userId) input.userId = parseInt(userId, 10);

  const username = getArg('--username');
  if (username) input.username = username;

  const modelId = getArg('--model-id');
  if (modelId) input.modelId = parseInt(modelId, 10);

  const modelVersionId = getArg('--model-version-id');
  if (modelVersionId) input.modelVersionId = parseInt(modelVersionId, 10);

  const postId = getArg('--post-id');
  if (postId) input.postId = parseInt(postId, 10);

  const remixOf = getArg('--remix-of');
  if (remixOf) input.remixOfId = parseInt(remixOf, 10);

  if (hasFlag('--remixes-only')) input.remixesOnly = true;
  if (hasFlag('--non-remixes-only')) input.nonRemixesOnly = true;
  if (hasFlag('--with-meta')) input.withMeta = true;
  if (hasFlag('--from-platform')) input.fromPlatform = true;

  const cursor = getArg('--cursor');
  if (cursor) input.cursor = cursor;

  const result = await query(input);

  if (hasFlag('--raw')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (hasFlag('--json')) {
    const items = (result.items || []).map(img => ({
      id: img.id,
      type: img.type,
      nsfw: img.nsfwLevel,
      avail: img.availability,
      user: img.user?.username || img.userId,
      date: (img.createdAt || img.sortAt || '').toString().slice(0, 10),
      baseModel: img.baseModel,
      reactions: img.stats ? {
        heart: img.stats.heartCountAllTime,
        like: img.stats.likeCountAllTime,
        laugh: img.stats.laughCountAllTime,
        cry: img.stats.cryCountAllTime,
        comment: img.stats.commentCountAllTime,
        collected: img.stats.collectedCountAllTime,
      } : { total: img.reactionCount },
      tags: img.tagIds?.slice(0, 5),
      modelVersionIds: img.modelVersionIds?.slice(0, 3),
      blocked: img.blockedFor || null,
      remix: img.remixOfId || null,
      meta: img.hasMeta,
      onSite: img.onSite,
    }));
    console.log(JSON.stringify({ count: items.length, nextCursor: result.nextCursor ?? null, items }, null, 2));
    return;
  }

  // Human-readable output
  const items = result.items || [];
  console.log(`\n  Query: ${JSON.stringify(input, null, 2)}\n`);
  console.log(`  Results: ${items.length} images${result.nextCursor ? ` (more available, cursor: ${String(result.nextCursor).slice(0, 40)}...)` : ' (no more pages)'}\n`);

  if (!items.length) {
    console.log('  No results.\n');
    return;
  }

  for (let i = 0; i < items.length; i++) {
    console.log(formatImage(items[i], i));
  }
  console.log();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
