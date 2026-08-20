<script lang="ts">
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import type { PageData } from './$types';
  import { entityUrl, userLookupUrl, userUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, num } from '$lib/format';

  type Article = NonNullable<PageData['result']>['article'];

  let { article, civitaiUrl }: { article: Article; civitaiUrl: string } = $props();

  const articleHref = $derived(entityUrl(civitaiUrl, 'article', article.id));

  const fields = $derived<[string, string][]>([
    ['Status', article.status],
    ['Availability', article.availability],
    // The author's own checkbox. Kept as a stored value rather than a badge: it is uncorrelated with
    // the effective rating (2,011 articles sit at X with this false, 735 at PG with it true), so
    // promoting it to the badge row asserts something the column does not support.
    ['Author marked NSFW', article.nsfw ? 'yes' : 'no'],
    ['Created', dateTime(article.createdAt)],
    ['Updated', dateTime(article.updatedAt)],
    ['Published', dateTime(article.publishedAt)],
    ['Ingestion', article.ingestion],
    ['Content scanned', dateTime(article.contentScannedAt)],
    ['Scan requested', dateTime(article.scanRequestedAt)],
    ['Body length', `${num(article.contentLength)} chars`],
  ]);

  // `coverId` superseded the legacy `cover` URL string. Reading only the id renders an article that has
  // just the old column as having no cover — beside a badge the cover is what produced.
  const coverLabel = $derived(
    article.coverId !== null
      ? `#${article.coverId}`
      : article.cover
        ? 'legacy cover (no image record)'
        : '—'
  );

  // `nsfwLevel` is what the site actually applies; the override sits above the content-derived level.
  const levels = $derived<[string, string][]>([
    ['Effective', getBrowsingLevelLabel(article.nsfwLevel)],
    ['User-set', getBrowsingLevelLabel(article.userNsfwLevel)],
    [
      'Moderator override',
      article.moderatorNsfwLevel === null ? '—' : getBrowsingLevelLabel(article.moderatorNsfwLevel),
    ],
    // Only meaningful under an override, and it is the number that says whether the gate may clear it:
    // basis below the override means the content was always lower, so it is not auto-clearable.
    ...(article.moderatorNsfwLevel === null
      ? []
      : ([
          [
            'Override basis',
            article.moderatorNsfwLevelBasis === null
              ? 'not recorded (predates the column)'
              : getBrowsingLevelLabel(article.moderatorNsfwLevelBasis),
          ],
        ] satisfies [string, string][])),
    // The cover is usually WHY the effective level is what it is, so it belongs beside the three.
    ['Cover image', coverLabel],
  ]);

  // Typed non-null by Prisma's generated Kysely types, but the column is nullable in the database.
  const locked = $derived(article.lockedProperties ?? []);
  const hasMetadata = $derived(
    !!article.metadata && Object.keys(article.metadata as object).length > 0
  );

  // `metadata` DOES carry moderation-bearing keys — measured across 3,392 articles carrying any:
  // profanityMatches/profanityEvaluation, unpublishedBy/At/Reason, customMessage. Buried in a raw JSON
  // dump none of it is read, so the moderation subset is lifted out and the dump stays below it.
  const meta = $derived((article.metadata ?? {}) as Record<string, unknown>);
  const asText = (v: unknown) =>
    v == null ? null : typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v);
  const modMeta = $derived(
    (
      [
        ['Unpublished', asText(meta.unpublishedAt)],
        ['Unpublished by', asText(meta.unpublishedBy)],
        ['Unpublish reason', asText(meta.unpublishedReason)],
        ['Message to author', asText(meta.customMessage)],
        // The evaluation is an object whose `reason` is the sentence a human wrote the check to say;
        // the metrics beside it are why that sentence fired and stay in the raw dump below.
        [
          'Profanity',
          typeof (meta.profanityEvaluation as { reason?: unknown })?.reason === 'string'
            ? ((meta.profanityEvaluation as { reason: string }).reason)
            : asText(meta.profanityEvaluation),
        ],
        [
          'Profanity matches',
          Array.isArray(meta.profanityMatches)
            ? `${meta.profanityMatches.length}: ${meta.profanityMatches.slice(0, 8).join(', ')}`
            : asText(meta.profanityMatches),
        ],
      ] as [string, string | null][]
    ).filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== '')
  );
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
    <h2 class="text-lg font-semibold text-white">
      {#if articleHref}
        <a href={articleHref} target="_blank" rel="noreferrer" class={LINK_CLASS}>{article.title}</a>
      {:else}
        {article.title}
      {/if}
    </h2>
    <code class="text-sm text-dark-2">#{article.id}</code>
    {#if article.tosViolation}<Badge variant="destructive">ToS violation</Badge>{/if}
    <!-- The rating badge comes from the EFFECTIVE level, not the author's `nsfw` checkbox: the two
         disagree on thousands of articles, and the badge row is what a moderator scans. -->
    <Badge variant={article.nsfwLevel > 1 ? 'destructive' : 'secondary'}>
      {getBrowsingLevelLabel(article.nsfwLevel)}
    </Badge>
    {#if article.availability !== 'Public'}
      <Badge variant="secondary">{article.availability}</Badge>
    {/if}
    <!-- Without this an unlisted article is indistinguishable from a public one, which is exactly the
         question "why isn't this showing up?" asks. -->
    {#if article.unlisted}
      <Badge variant="secondary">unlisted</Badge>
    {/if}
    {#if article.status !== 'Published'}<Badge variant="secondary">{article.status}</Badge>{/if}
  </div>

  <p class="mt-1 text-sm text-dark-2">
    by
    <a href={userLookupUrl(article.username ?? article.userId)} class={LINK_CLASS}>
      {article.username ?? `#${article.userId}`}
    </a>
    {#if article.username}
      ·
      <a
        href={userUrl(civitaiUrl, article.username)}
        target="_blank"
        rel="noreferrer"
        class={LINK_CLASS}
      >
        profile
      </a>
    {/if}
    {#if article.userBannedAt}
      <Badge variant="destructive">author banned</Badge>
    {/if}
  </p>

  <dl class="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
    {#each fields as [label, value] (label)}
      <div>
        <dt class="text-xs tracking-wide text-dark-2 uppercase">{label}</dt>
        <dd class="text-dark-0">{value}</dd>
      </div>
    {/each}
  </dl>

  <div class="mt-4 border-t border-dark-4 pt-4">
    <h3 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">NSFW level</h3>
    <div class="flex flex-wrap gap-x-8 gap-y-2 text-sm">
      {#each levels as [label, value] (label)}
        <div>
          <span class="text-dark-0">{value}</span>
          <span class="ml-1 text-xs text-dark-2">{label.toLowerCase()}</span>
        </div>
      {/each}
    </div>
  </div>

  {#if modMeta.length}
    <div class="mt-4 border-t border-dark-4 pt-4">
      <h3 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Moderation metadata</h3>
      <dl class="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        {#each modMeta as [label, value] (label)}
          <div class="min-w-0">
            <dt class="text-xs tracking-wide text-dark-2 uppercase">{label}</dt>
            <dd class="wrap-break-word text-dark-0">{value}</dd>
          </div>
        {/each}
      </dl>
    </div>
  {/if}

  {#if hasMetadata}
    <div class="mt-4 border-t border-dark-4 pt-4">
      <h3 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Metadata (raw)</h3>
      <pre class="overflow-x-auto rounded-md bg-dark-7 p-2 text-xs text-dark-0">{JSON.stringify(
          article.metadata,
          null,
          2
        )}</pre>
    </div>
  {/if}

  {#if locked.length}
    <div class="mt-4 border-t border-dark-4 pt-4">
      <h3 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Locked properties</h3>
      <div class="flex flex-wrap gap-1">
        {#each locked as prop}
          <Badge variant="secondary">{prop}</Badge>
        {/each}
      </div>
    </div>
  {/if}
</section>
