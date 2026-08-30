import * as z from 'zod';
// 🔴 BOTH ARE PURE ENUM MODULES — CHECKED, NOT ASSUMED. This file's header
// forbids server imports so it stays unit-testable without dragging Prisma:
// `~/server/common/enums` has NO imports at all, and `~/shared/utils/prisma/enums`
// only re-exports `@civitai/db-schema/enums`. Neither pulls the Prisma client.
import { ModelSort } from '~/server/common/enums';
import { MetricTimeframe, ModelType } from '~/shared/utils/prisma/enums';

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks READ-ONLY TOOL REGISTRY (#398 AC5).
//
// WHAT THIS IS. The code-enumerated allowlist of tools an App Block may declare
// to a chat model, plus — for each — the ONE schema that is both (a) handed to
// the model as its JSON-Schema `parameters` and (b) used to validate the
// arguments the model sends back. AC5 requires the allowlist be "enumerated in
// code"; this module is that enumeration.
//
// 🔴 THIS MODULE KEEPS PRISMA OFF ITS LOAD PATH, and that is deliberate rather
// than tidy.
//
// ⚠️ IT USED TO SAY "SERVER-IMPORT-FREE", AND THAT WORDING IS NOW FALSE — an
// audit caught it. This file imports `ModelSort` from `~/server/common/enums`
// and `MetricTimeframe`/`ModelType` from `~/shared/utils/prisma/enums`, so the
// literal claim does not hold. The PROPERTY it was protecting does: both are
// pure enum modules — `~/server/common/enums` has one import
// (`@civitai/notifications/constants`, itself importing nothing) and the shared
// one only re-exports `@civitai/db-schema/enums`. Neither drags the Prisma
// client. The rule to apply when adding an import here is therefore "does this
// pull Prisma or a service onto the load path", not "is it under ~/server".
// Pinned by `__tests__/registry.test.ts`, which asserts THIS FILE'S DIRECT
// import list against an allowlist. ⚠️ It does NOT walk the graph — an earlier
// version of this sentence claimed it did, and an audit showed a side-effect
// import (`import '~/server/db/client';`, no `from`) and a TRANSITIVE one both
// pass it. It is a ratchet on direct imports, which is the change most likely
// to happen by hand; a real graph walk would be strictly better. It mirrors the reasoning `~/server/utils/block-catalog-maturity` states
// for the maturity clamp: the security-relevant parts (the allowlist, the
// argument bounds, the projection, the AIR scrub) must be unit-testable without
// dragging the Prisma client, and the only backing implementation available
// today statically imports a search service which eagerly loads Prisma. The
// DISPATCH — the part that actually talks to the catalog — lives in the route.
//
// 🔴 READ-ONLY AND FIRST-PARTY ONLY. Every entry must be a read of Civitai's own
// catalog. That is not a style rule, it is what makes the moderation answer for
// #398 hold: tool RESULTS are not scanned by any text scanner, and the argument
// for that being acceptable is precisely that they are first-party, already
// published, already moderated, and maturity-clamped to the viewer's own
// ceiling. A non-first-party tool (a web fetch, a third-party API) breaks that
// argument and needs its own scan before it can be listed here. A WRITE tool
// breaks something worse: it would let a model's own output take an action.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 WHY THIS IS NOT AN MCP PROXY, which is what #398 AC5's prose asks for.
//
// `mcp.civitai.com` exposes `search_models` over the same catalog, and routing a
// block to it through `/api/v1/blocks/*` LOOKS like the smaller change. It is
// not viable, measured rather than reasoned:
//
//   - its `search_models` input schema has NO nsfw / browsingLevel / maturity
//     parameter and is `additionalProperties: false`, so a proxy cannot pass the
//     viewer's ceiling through; and
//   - its results carry only `air` / `id` / `name` / `type` — no maturity
//     metadata at all — so a proxy cannot filter what comes BACK either, short
//     of re-resolving every returned id against our own database.
//
// 🔴 And the trap that makes the proxy look safe: THE MATURITY CLAMP IS NOT
// INHERITED FROM THE `/api/v1/blocks/*` PREFIX. `withBlockScope` gives a route
// the JWT gate, the opaque-origin CORS, the rate limit and the audit row. It
// does NOT give it the clamp — `blocks/models.ts` says so in its own words, that
// `resolveCatalogBrowsingLevel` "remains the whole authority surface". A new
// route under that prefix that forgets to call it is unclamped while looking
// exactly as protected as its neighbours.
//
// So the tools are backed by the SAME clamped path `/api/v1/blocks/models`
// already uses. That endpoint is strictly better than the MCP one for this
// purpose: the ceiling is applied server-side from the token claim and the
// client cannot widen it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The serialized-character budget for one tool RESULT.
 *
 * 🔴 THIS EXISTS BECAUSE THE RESULT HAS TO SURVIVE A ROUND TRIP. The block feeds
 * it back to the model as a `role: 'tool'` message, and that message's `content`
 * is bounded by `MAX_MESSAGE_CHARS` (8,000) in the chat-completion step's param
 * schema. A result larger than that cannot be replayed at all — the submit is a
 * BAD_REQUEST — so an unbounded projection is not "generous", it is a result the
 * caller can never use.
 *
 * Set BELOW the message cap, not equal to it, so a block can prepend its own
 * framing ("Results for X:") without pushing the message over.
 *
 * 🔴 THE LINK TO `MAX_MESSAGE_CHARS` IS ASSERTED IN A TEST, NOT IMPORTED. This
 * module keeps Prisma off its load path on purpose (see the header); importing
 * `chat-completion.step` here would drag the step registry onto its load path
 * and defeat that. `__tests__/registry.test.ts` imports BOTH and goes red if
 * either constant moves — the same technique `chat-completion.step` already uses
 * for its own link to `MAX_SCANNED_CONTENT_CHARS`.
 */
export const MAX_TOOL_RESULT_CHARS = 6_000;

/** Hard cap on results returned in one call, independent of the char budget. */
export const MAX_TOOL_RESULT_ITEMS = 10;

/**
 * Bounds on the ARRAY-valued and free-text FILTERS (`types`, `baseModels`,
 * `tag`, `username`).
 *
 * 🔴 THESE BOUND A SQL `IN` LIST, NOT A RESPONSE. Every other cap in this file
 * exists to keep a RESULT replayable; these exist because the values are
 * forwarded into the catalog query itself — `model.service` joins `baseModels`
 * straight into an `IN (…)` — and the caller is an untrusted sandboxed iframe
 * relaying a language model's output. An unbounded array is an unbounded query,
 * which is a cost problem rather than a correctness one and therefore fails
 * quietly.
 *
 * The per-value length is generous enough for real base-model names
 * ("Stable Diffusion XL 1.0", "Illustrious") and real usernames, and nowhere
 * near enough to smuggle a payload.
 */
export const MAX_TOOL_FILTER_ITEMS = 10;
export const MAX_TOOL_FILTER_VALUE_CHARS = 64;

/**
 * How many Meilisearch candidates to pull when a text `query` is combined with
 * an explicit `sort`.
 *
 * 🔴 WITHOUT THIS THE SORT IS APPLIED TO THE WRONG SET. Meili returns the top-N
 * by RELEVANCE; the database then orders those N by `sort`. If N is the page
 * size, "the most downloaded anime models" means "take the 5 most RELEVANT
 * matches for 'anime', then put those 5 in download order" — which is not the
 * question. Widening the candidate pool first, and letting the database pick
 * the page out of it, makes the sort mean what it says.
 *
 * Bounded, and deliberately modest: this is an id-only Meili read whose cost is
 * the id list, but it is still a bigger read than the page, issued on behalf of
 * an untrusted caller. It only fires when BOTH a query and an explicit sort are
 * present.
 */
export const TOOL_SORTED_QUERY_CANDIDATES = 100;

/**
 * How many results a call returns when it does not ask.
 *
 * 🔴 LIVES HERE SO THE NUMBER THE MODEL IS TOLD AND THE NUMBER THE ROUTE APPLIES
 * ARE ONE VALUE. The `limit` declaration below tells the model "default 5"; the
 * route applies its own default when `limit` is absent. Those were two separate
 * literals, so changing the route's default would have left the declaration
 * confidently describing the old one — and the declaration is the model's only
 * source of truth about the contract, so the drift is invisible until a caller
 * relies on it. Interpolated into the `.describe` below and imported by the
 * route; do not write `5` in either place again.
 */
export const DEFAULT_TOOL_RESULT_ITEMS = 5;

/**
 * Bounds on individual projected strings, so one pathological field cannot eat
 * the budget.
 *
 * 🔴 EXPORTED SO THE TESTS CAN REACH THE BRANCH THEY CLAIM TO COVER. An audit
 * killed four mutants here — widening any of these to 100000, and deleting
 * `str()`'s truncation branch outright — because every fixture in the suite sat
 * comfortably UNDER each bound, so the truncation never executed and the
 * docstring's "one pathological field cannot eat the budget" had zero coverage.
 *
 * 🔴 ALL FIVE PROJECTED STRING FIELDS ARE NAMED HERE, and that is the point of
 * the list rather than tidiness. A LATER audit found `type` and `baseModel` had
 * been left on a bare `40` while the other three were converted — so two of the
 * five sat outside the block whose docstring claimed to cover "individual
 * projected strings", and widening either survived the suite. A bound that is a
 * magic number at its call site cannot be reached from a test by name.
 *
 * The fixtures do NOT derive their length from these constants — they overshoot
 * by a literal, and the drift guard in the test file is what keeps them reaching
 * if a constant moves. See that file's own note for why a constant-derived
 * fixture is the weaker choice: it moves WITH the mutant and stops discriminating.
 */
export const MAX_PROJECTED_NAME_CHARS = 120;
export const MAX_PROJECTED_TAG_CHARS = 40;
export const MAX_PROJECTED_CREATOR_CHARS = 60;
export const MAX_PROJECTED_TYPE_CHARS = 40;
export const MAX_PROJECTED_BASE_MODEL_CHARS = 40;
export const MAX_PROJECTED_TAGS = 8;

/**
 * The AIR URN prefix, lowercase.
 *
 * 🔴 DUPLICATED FROM `steps/index`'s `AIR_URN_PREFIX` ON PURPOSE, and the
 * duplication is asserted in the tests rather than left to drift. Importing it
 * would pull the step registry onto this module's load path, which the
 * Prisma-free load-path property forbids. The test imports both and fails if they
 * diverge — the same trade this file makes for `MAX_MESSAGE_CHARS`.
 */
export const AIR_URN_PREFIX_LOCAL = 'urn:air:';

/**
 * Replace any AIR URN prefix appearing in a string with an inert spelling.
 *
 * 🔴 WHY A TOOL RESULT MUST NOT CARRY `urn:air:` AT ALL. The block puts this
 * result into `messages` and submits it. `containsAirReference` (steps/index)
 * is a case-insensitive SUBSTRING scan over every string, array element, object
 * value AND object key of the built step input, and the router throws FORBIDDEN
 * on a hit — on the estimate path and the submit path both. So a result carrying
 * the literal does not degrade, it makes the round trip impossible.
 *
 * This is not hypothetical: measured against the live MCP server, a single
 * `search_models` call at `limit: 1` returned THIRTY-ONE `urn:air:` literals, in
 * both its human-readable text and its structured content.
 *
 * 🔴 SCRUB, DO NOT DROP. The projection below is an allowlist and never copies
 * an AIR field, so in the ordinary case there is nothing here to do. What this
 * catches is the residual: a user-authored model NAME (or tag) that happens to
 * contain the literal. Dropping such a model would silently hide a real catalog
 * entry from the model's view for a cosmetic reason; neutralising the prefix
 * keeps the row and costs the reader nothing, because the block does not need
 * AIRs to answer a question about a model.
 *
 * Case-insensitive, because the scan it defends against is.
 *
 * 🔴 DEPTH-CAPPED, AND THE FAIL DIRECTION IS THE OPPOSITE OF ITS SIBLING'S.
 * `containsAirReference` (steps/index) is a DETECTOR, so past `AIR_SCAN_MAX_DEPTH`
 * it returns TRUE — "I could not prove this carries no AIR". This is a SCRUBBER,
 * and the mirror of that is not "stop recursing": stopping would RETURN the
 * over-deep subtree unscrubbed, which is fail-OPEN — exactly the literal this
 * function exists to remove, surviving because the input was nested. So at the
 * cap it substitutes a constant that carries no caller content at all, which is
 * trivially AIR-free.
 *
 * Without the cap, deep recursion on a caller-shaped value is a `RangeError` —
 * the same crash class the sibling's cap exists for, and it would turn a 400
 * into a 500. Not reachable through today's two call sites, which both pass a
 * string: this is a property of an EXPORTED function, whose next caller is the
 * one that would find out.
 */
const NEUTRALIZE_MAX_DEPTH = 128;

/**
 * What replaces a subtree past `NEUTRALIZE_MAX_DEPTH`. A first-party constant,
 * so it cannot itself contain the literal being scrubbed.
 */
export const NEUTRALIZE_DEPTH_PLACEHOLDER = '[omitted: nested too deeply to scrub]';

export function neutralizeAirLiterals<T>(value: T): T {
  return scrubAirLiterals(value, 0);
}

/**
 * 🔴 THE DEPTH PARAMETER IS PRIVATE, AND THAT IS NOT STYLE — IT IS THE WHOLE
 * REASON THIS HELPER EXISTS.
 *
 * An exported `neutralizeAirLiterals(value, depth = 0)` is arity-2 with a
 * `number` second parameter, which is EXACTLY `Array.prototype.map`'s callback
 * shape. So `names.map(neutralizeAirLiterals)` passes the INDEX as `depth`, and
 * every element from index 129 on is replaced by the placeholder instead of
 * being scrubbed — measured on a 200-element array: 129 scrubbed, 71 destroyed.
 * `tsc` reports zero errors on it, because the signature genuinely matches.
 *
 * The damage is destructive rather than leaky (content is replaced, not
 * exposed), but it is silent, un-typechecked, and the point-free `.map(fn)` form
 * is the most natural way anyone would ever call this over a projected row set.
 * Keeping the public signature single-arg makes the hazard unwritable.
 */
function scrubAirLiterals<T>(value: T, depth: number): T {
  if (depth > NEUTRALIZE_MAX_DEPTH) return NEUTRALIZE_DEPTH_PLACEHOLDER as unknown as T;
  if (typeof value === 'string') {
    return value.replace(/urn:air:/gi, 'urn-air-') as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubAirLiterals(v, depth + 1)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Keys are scrubbed too: `containsAirReference` scans object KEYS, because
      // the orchestrator's own `additionalNetworks` / `WorkflowCost.fees` shapes
      // are AIR-keyed maps.
      out[scrubAirLiterals(k, depth + 1)] = scrubAirLiterals(v, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Read a string field defensively off an `unknown` search item.
 *
 * 🔴 THE CUT IS SURROGATE-AWARE. `String.prototype.slice` counts UTF-16 CODE
 * UNITS, and an astral character (emoji, and every non-BMP script) occupies two.
 * Cutting between them emits a LONE SURROGATE: still valid JSON — it serializes
 * as `\udXXX` — so nothing downstream errors, and the model simply reads
 * mojibake at the boundary. Measured on an emoji-heavy name before this guard
 * existed. Catalog names are user-authored and routinely emoji-laden, so this is
 * the ordinary case rather than a pathological one.
 */
function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= max) return trimmed;
  let cut = max - 1;
  // The last retained unit is at `cut - 1`. If it is a HIGH surrogate its
  // partner sits at `cut` and would be dropped, so retreat one unit and let the
  // ellipsis take the slack.
  const last = trimmed.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${trimmed.slice(0, cut)}…`;
}

/** Read a finite number field defensively off an `unknown` search item. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** One projected catalog row, as the model sees it. */
export type ProjectedModel = {
  id: number;
  name: string;
  type?: string;
  baseModel?: string;
  creator?: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
  url: string;
};

/**
 * Project ONE raw search item down to what a chat model needs.
 *
 * 🔴 AN ALLOWLIST, NEVER A DENYLIST, and that is the load-bearing choice. The
 * raw row from `runModelSearch` is a full model record: every published version,
 * every file, file hashes, download URLs, image URLs — and AIR identifiers. A
 * denylist ("strip the air fields") is one upstream field addition away from
 * leaking, and the upstream shape is typed `unknown` precisely because it is not
 * this module's contract. Building the output from named fields means a new
 * upstream field is invisible here by construction.
 *
 * The size argument is the same one: the raw row is orders of magnitude larger
 * than the round-trip budget, so a passthrough could never be replayed anyway.
 *
 * Returns `null` for a row without the two fields that make a result useful at
 * all (a numeric id and a name), rather than emitting a half-row the model would
 * have to reason about.
 */
export function projectModelForTool(raw: unknown): ProjectedModel | null {
  if (raw === null || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;

  const id = num(row.id);
  const name = str(row.name, MAX_PROJECTED_NAME_CHARS);
  if (id === undefined || name === undefined) return null;

  const creatorRecord =
    row.creator !== null && typeof row.creator === 'object'
      ? (row.creator as Record<string, unknown>)
      : undefined;

  // The newest published version is the only one a "which model should I use"
  // answer needs; the full version list is both noise and budget.
  const versions = Array.isArray(row.modelVersions) ? row.modelVersions : [];
  const latest =
    versions.length > 0 && versions[0] !== null && typeof versions[0] === 'object'
      ? (versions[0] as Record<string, unknown>)
      : undefined;

  const statsRecord =
    row.stats !== null && typeof row.stats === 'object'
      ? (row.stats as Record<string, unknown>)
      : undefined;

  const tags = Array.isArray(row.tags)
    ? row.tags
        .map((t) => str(t, MAX_PROJECTED_TAG_CHARS))
        .filter((t): t is string => t !== undefined)
        .slice(0, MAX_PROJECTED_TAGS)
    : undefined;

  const projected: ProjectedModel = {
    id,
    name,
    ...(str(row.type, MAX_PROJECTED_TYPE_CHARS) !== undefined
      ? { type: str(row.type, MAX_PROJECTED_TYPE_CHARS) }
      : {}),
    ...(latest && str(latest.baseModel, MAX_PROJECTED_BASE_MODEL_CHARS) !== undefined
      ? { baseModel: str(latest.baseModel, MAX_PROJECTED_BASE_MODEL_CHARS) }
      : {}),
    ...(creatorRecord && str(creatorRecord.username, MAX_PROJECTED_CREATOR_CHARS) !== undefined
      ? { creator: str(creatorRecord.username, MAX_PROJECTED_CREATOR_CHARS) }
      : {}),
    ...(statsRecord && num(statsRecord.downloadCount) !== undefined
      ? { downloads: num(statsRecord.downloadCount) }
      : {}),
    // 🔴 PROJECTED *BECAUSE* `sort` NOW OFFERS "Most Liked". Without it the tool
    // could rank by likes and then hand the model only a DOWNLOAD count to
    // explain the ranking with — so the answer would either cite the wrong
    // number or be unable to justify its own order. A sort key the result cannot
    // evidence is worse than no sort key. `thumbsUpCount` is already on the row;
    // one number per item is a negligible slice of MAX_TOOL_RESULT_CHARS.
    ...(statsRecord && num(statsRecord.thumbsUpCount) !== undefined
      ? { likes: num(statsRecord.thumbsUpCount) }
      : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    url: `https://civitai.com/models/${id}`,
  };

  // Belt and braces over the allowlist: a user-authored name or tag can still
  // carry the literal. See `neutralizeAirLiterals`.
  return neutralizeAirLiterals(projected);
}

/**
 * Bound a projected list to the serialized-character budget.
 *
 * 🔴 DROPS WHOLE ROWS, NEVER TRUNCATES THE SERIALISED STRING. Cutting a JSON
 * string at a byte offset produces invalid JSON, which the block then cannot
 * parse and the model cannot read — a failure mode strictly worse than fewer
 * results. So rows are added while they fit and the remainder is reported as a
 * count, which also tells the model that more exist.
 */
export function boundToolResult(items: ProjectedModel[]): {
  items: ProjectedModel[];
  truncated: number;
} {
  const kept: ProjectedModel[] = [];
  for (const item of items.slice(0, MAX_TOOL_RESULT_ITEMS)) {
    const candidate = [...kept, item];
    if (JSON.stringify({ items: candidate }).length > MAX_TOOL_RESULT_CHARS) break;
    kept.push(item);
  }
  return { items: kept, truncated: items.length - kept.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE REGISTRY.
//
// 🔴 ONE SCHEMA PER TOOL, AND THE JSON SCHEMA IS DERIVED FROM IT. The
// `parameters` object handed to the model is `z.toJSONSchema(argsSchema)`, not a
// hand-written twin. That makes "the model was shown a contract the route does
// not enforce" structurally impossible rather than test-enforced: there is only
// one definition, and the served document is a projection of it. (The repo
// already uses `z.toJSONSchema` this way in `~/server/utils/moderator-endpoint`.)
// ─────────────────────────────────────────────────────────────────────────────

const searchModelsArgs = z
  .object({
    // 🔴 OPTIONAL, AND THAT IS THE WHOLE POINT OF THIS FIELD'S SHAPE. While
    // `query` was REQUIRED the model had exactly one lever, so a ranking
    // question it could not express became a TEXT SEARCH FOR THE RANKING WORD:
    // "most popular models" went out as `query: "popular"` and came back with
    // models literally NAMED "Popular …" — 2,168 downloads against a real
    // top-of-catalog of 2.3M. Reproduce with
    // `civitai models search --query "popular"`. Absent `query`, the route
    // skips Meilisearch entirely and `runModelSearch` does a pure sorted
    // catalog read, exactly as `blocks/models.ts` already does.
    query: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Free-text search over model names and keywords. OMIT it to rank the whole catalog — ' +
          'do not put a ranking word like "popular" or "best" here, that searches for the word itself.'
      ),
    // 🔴 THE RANKING LEVER, PREVIOUSLY ABSENT. The route hardcoded
    // `constants.modelFilterDefaults.sort` (Highest Rated), so no phrasing could
    // ask for most-downloaded. `blocks/models.ts` — the route a block calls
    // DIRECTLY — has exposed `z.enum(ModelSort).optional()` all along, so tool
    // calling was strictly LESS capable than the REST surface it replaced. Same
    // enum deliberately: a curated subset here would be a second rule that can
    // drift from the one `models.ts` already enforces.
    sort: z
      .enum(ModelSort)
      .optional()
      .describe(
        // 🔴 THE DEFAULT IS A LITERAL, AND ITS LINK TO
        // `constants.modelFilterDefaults.sort` IS ASSERTED IN A TEST RATHER THAN
        // IMPORTED — the same trade this file already makes for
        // `MAX_MESSAGE_CHARS`, and for the same reason: importing
        // `~/server/common/constants` here would put a server module on this
        // one's load path and break the Prisma-free load-path property the header
        // depends on. `registry.test.ts` fails if the two ever diverge.
        'How to rank results (default "Highest Rated"). Use "Most Downloaded" or "Most Liked" ' +
          'for popularity questions, "Newest" for recency. Combining it with `query` ranks ' +
          'within the text matches rather than by relevance.'
      ),
    // 🔴 WAS A SINGULAR `type` ON A SIX-VALUE HAND-WRITTEN ENUM, and both halves
    // were wrong. `ModelType` has far more members — `Wildcards`, `Poses`,
    // `Workflows`, `ComfyWorkflows`, `Hypernetwork`, `Upscaler`, `MotionModule`,
    // `Detection`, `LLM`, `DoRA`, … — so the tool could RETURN a row it could not
    // ASK for. Measured 2026-08-30: a live answer cited a `Wildcards` model while
    // that value was unrepresentable in this enum. Now the enum itself, plural,
    // exactly as the public schema and `blocks/models.ts` express it.
    types: z
      .array(z.enum(ModelType))
      .min(1)
      .max(MAX_TOOL_FILTER_ITEMS)
      .optional()
      .describe('Restrict to these model types'),
    // 🔴 THE FILTER MOST POPULARITY QUESTIONS ACTUALLY TURN ON. "the best SDXL
    // checkpoint", "Illustrious LoRAs" — unanswerable while this was absent, and
    // `blocks/models.ts` has always had it. Free text rather than an enum,
    // matching the public schema: base-model names are data, not a code-owned
    // set, and an enum here would silently drop every newly-released family.
    baseModels: z
      .array(z.string().min(1).max(MAX_TOOL_FILTER_VALUE_CHARS))
      .min(1)
      .max(MAX_TOOL_FILTER_ITEMS)
      .optional()
      .describe('Restrict to these base models, e.g. "SDXL 1.0", "Illustrious", "Pony"'),
    // The route hardcoded AllTime, so "most downloaded THIS MONTH" could not be
    // asked. `sort` without `period` only ever ranks over all time.
    // 🔴 THE DESCRIPTION SAYS WHAT THIS ACTUALLY DOES, WHICH IS NOT WHAT ITS
    // NAME SUGGESTS. `period` does NOT compute the ranking over a timeframe: in
    // `getModelsRaw` it adds a hard filter on `lastVersionAt`, while the
    // `orderBy` ladder reads all-time `downloadCount`/`thumbsUpCount` and never
    // references it. The projected `downloads`/`likes` are all-time too. An
    // earlier draft of this field described it as "the timeframe the ranking is
    // computed over" — an audit caught that, and a model reading it would have
    // reported all-time figures as "this month".
    period: z
      .enum(MetricTimeframe)
      .optional()
      .describe(
        'Restrict to models with a version published in this timeframe. Ranking and the ' +
          'returned counts remain ALL-TIME — this narrows the set, it does not re-rank it.'
      ),
    supportsGeneration: z
      .boolean()
      .optional()
      .describe('Only models that can be generated with on Civitai'),
    // 🔴 `tag` AND `username` ARE DELIBERATELY ABSENT — they were added here and
    // then REMOVED, so do not "restore parity" by putting them back without
    // fixing what follows. Both FAIL OPEN in the shared catalog service, which
    // is the one failure direction an LLM caller must never be handed:
    //
    //   - `tag` is resolved by exact name and the predicate is pushed only
    //     `if (tagId)` (`model.service`), so an unknown tag adds NO filter and
    //     the call returns the site-wide top N presented as "models tagged X".
    //   - `username` is matched on a SLUGIFIED column, and `postgresSlugify`
    //     strips everything outside [a-zA-Z0-9_] — so a non-ASCII or
    //     punctuation-only name slugifies to the EMPTY string, the filter is
    //     dropped (`if (username || user)`), and the whole catalog comes back.
    //     A non-empty-but-unknown username throws instead, so the dangerous
    //     direction is the quiet one.
    //
    // A human typing a wrong tag into a search box sees an obviously unfiltered
    // page. A language model gets a plausible list and reports it as the answer
    // — the same fabrication this file's `sort` work exists to stop. Restoring
    // them needs validation (resolve the tag id, reject an empty slug) rather
    // than a schema line.
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_TOOL_RESULT_ITEMS)
      .optional()
      .describe(
        `Maximum results to return (default ${DEFAULT_TOOL_RESULT_ITEMS}, max ${MAX_TOOL_RESULT_ITEMS})`
      ),
  })
  .strict();

export type SearchModelsArgs = z.infer<typeof searchModelsArgs>;

export type BlockToolDefinition = {
  /** The tool name the model calls. Must satisfy the chat step's `TOOL_NAME_PATTERN`. */
  name: string;
  /** Shown to the model. */
  description: string;
  /** The argument contract — the ONE definition. */
  argsSchema: z.ZodType;
};

const TOOLS: readonly BlockToolDefinition[] = [
  {
    name: 'search_models',
    description:
      "Search or rank Civitai's model catalog. Returns models with their id, name, type, " +
      'base model, creator, download count and like count, restricted to what this viewer is ' +
      'allowed to see. Filter with `types`, `baseModels`, `tag`, `username` or ' +
      '`supportsGeneration`; rank with `sort` and `period`. ' +
      'For a NAMED model pass `query` ALONE — adding `sort` there ranks a hundred fuzzy ' +
      'matches and can push the exact model out of the results. For a POPULARITY question ' +
      'pass `sort`: with no `query` to rank the whole catalog, or WITH one to rank within ' +
      'those matches (e.g. the most downloaded anime models is `query: "anime"` plus ' +
      '`sort: "Most Downloaded"`). Never put a ranking word like "popular" or "best" in ' +
      '`query` — that searches for the word itself in model names.',
    argsSchema: searchModelsArgs,
  },
] as const;

/**
 * The allowlist, frozen, with a null prototype.
 *
 * The null prototype is a control, not a style choice — the same one the step
 * registry documents for `STEP_TYPE_ACCEPTABLE_POSTURES`. With a plain object a
 * lookup for the tool name `toString` returns `Object.prototype.toString`, which
 * is TRUTHY, so an `if (!tool) reject` guard fails OPEN on a prototype key. With
 * a null prototype every non-own key reads `undefined` and is rejected.
 */
const TOOLS_BY_NAME: Readonly<Record<string, BlockToolDefinition>> = Object.freeze(
  Object.assign(
    Object.create(null) as Record<string, BlockToolDefinition>,
    Object.fromEntries(TOOLS.map((t) => [t.name, t]))
  )
);

/** The registered tool names, in declaration order. */
export const BLOCK_TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

/** Look up a tool by name. Returns `undefined` for anything not registered. */
export function getBlockTool(name: string): BlockToolDefinition | undefined {
  return TOOLS_BY_NAME[name];
}

/**
 * The tool definitions as a block declares them to the model — the exact
 * `tools[]` payload shape the chat-completion step accepts.
 *
 * Derived, never hand-written: `parameters` is `z.toJSONSchema` of the same
 * `argsSchema` the route validates against.
 */
export function blockToolDeclarations(): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}> {
  return TOOLS.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      // `io: 'input'` because this describes what the model SENDS; matches the
      // call form already used elsewhere in the repo.
      parameters: z.toJSONSchema(tool.argsSchema, { io: 'input', unrepresentable: 'any' }),
    },
  }));
}
