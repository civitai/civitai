<script lang="ts">
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { bulkImageManagerUrl, entityUrl, userLookupUrl, userUrl } from '$lib/entity-url';
  import { humanizeUnpublishReason } from '$lib/articles';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type { PageData } from './$types';

  type Result = NonNullable<PageData['result']>;

  let {
    model,
    actors,
    civitaiUrl,
  }: { model: Result['model']; actors: Result['actors']; civitaiUrl: string } = $props();

  const modelHref = $derived(entityUrl(civitaiUrl, 'model', model.id));
  const actor = (id: number | null | undefined) =>
    id ? (actors[id] ?? `#${id}`) : null;

  const fields = $derived<[string, string][]>([
    ['Type', model.checkpointType ? `${model.type} · ${model.checkpointType}` : model.type],
    ['Status', model.status],
    ['Availability', model.availability],
    // Archived and TakenDown are NOT statuses: a taken-down model still reads `Published` in the row
    // above, so the mode is the only place that state appears.
    ['Mode', model.mode ?? 'normal'],
    ['Upload type', model.uploadType],
    ['Created', dateTime(model.createdAt)],
    ['Updated', dateTime(model.updatedAt)],
    ['Published', dateTime(model.publishedAt)],
    ['Last version', dateTime(model.lastVersionAt)],
    ['Scanned', dateTime(model.scannedAt)],
    ['Description', `${num(model.descriptionLength)} chars`],
  ]);

  const license = $derived<[string, string][]>([
    ['Credit required', model.allowNoCredit ? 'no' : 'yes'],
    ['Derivatives', model.allowDerivatives ? 'allowed' : 'blocked'],
    ['Different license', model.allowDifferentLicense ? 'allowed' : 'blocked'],
    ['Commercial use', model.allowCommercialUse.length ? model.allowCommercialUse.join(', ') : 'none'],
  ]);

  /**
   * 🔴 `Model.meta` is not always an object. A handful of rows hold an ARRAY whose second element is the
   * real meta — including the unpublish record — so reading keys off the raw value on those would print
   * an empty moderation record beside a model that plainly was unpublished. Narrowed to a plain object
   * here, and the raw block below renders whenever meta is non-empty, so the odd shape is shown rather
   * than silently read as nothing.
   */
  const meta = $derived(
    model.meta && typeof model.meta === 'object' && !Array.isArray(model.meta)
      ? (model.meta as Record<string, unknown>)
      : {}
  );
  const asText = (v: unknown) =>
    v == null ? null : typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v);

  // `ModelMeta` in `src/server/schema/model.schema.ts` is the shape of `Model.meta`.
  const modMeta = $derived(
    (
      [
        ['Needs review', meta.needsReview ? 'yes' : null],
        ['Unpublished', asText(meta.unpublishedAt)],
        ['Unpublished by', actor(meta.unpublishedBy as number | undefined)],
        [
          'Unpublish reason',
          typeof meta.unpublishedReason === 'string'
            ? humanizeUnpublishReason(meta.unpublishedReason)
            : null,
        ],
        ['Message to author', asText(meta.customMessage)],
        ['Taken down', asText(meta.takenDownAt)],
        ['Taken down by', actor(meta.takenDownBy as number | undefined)],
        ['Archived', asText(meta.archivedAt)],
        ['Archived by', actor(meta.archivedBy as number | undefined)],
        ['Declined', asText(meta.declinedAt)],
        ['Declined reason', asText(meta.declinedReason)],
        ['Cannot publish', meta.cannotPublish ? 'yes' : null],
        ['Cannot promote', meta.cannotPromote ? 'yes' : null],
        ['Comments locked', meta.commentsLocked ? 'yes' : null],
        [
          'Profanity',
          typeof (meta.profanityEvaluation as { reason?: unknown })?.reason === 'string'
            ? (meta.profanityEvaluation as { reason: string }).reason
            : asText(meta.profanityEvaluation),
        ],
        [
          'Profanity matches',
          Array.isArray(meta.profanityMatches)
            ? `${meta.profanityMatches.length}: ${meta.profanityMatches.slice(0, 8).join(', ')}`
            : null,
        ],
      ] as [string, string | null][]
    ).filter((entry): entry is [string, string] => !!entry[1])
  );

  const hasMeta = $derived(
    Array.isArray(model.meta) ? model.meta.length > 0 : Object.keys(meta).length > 0
  );
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
    <h2 class="text-lg font-semibold text-white">
      {#if modelHref}
        <a href={modelHref} target="_blank" rel="noreferrer" class={LINK_CLASS}>{model.name}</a>
      {:else}
        {model.name}
      {/if}
    </h2>
    <code class="text-sm text-dark-2">#{model.id}</code>
    {#if model.deletedAt}<Badge variant="destructive">deleted</Badge>{/if}
    {#if model.tosViolation}<Badge variant="destructive">ToS violation</Badge>{/if}
    <!-- From the EFFECTIVE level, not the author's `nsfw` checkbox: the two disagree, and the badge row
         is what a moderator scans. -->
    <Badge variant={model.nsfwLevel > 1 ? 'destructive' : 'secondary'}>
      {getBrowsingLevelLabel(model.nsfwLevel)}
    </Badge>
    {#if model.poi}<Badge variant="destructive">POI</Badge>{/if}
    {#if model.minor}<Badge variant="destructive">minor</Badge>{/if}
    {#if model.sfwOnly}<Badge variant="secondary">SFW only</Badge>{/if}
    {#if model.underAttack}<Badge variant="destructive">under attack</Badge>{/if}
    {#if model.locked}<Badge variant="secondary">locked</Badge>{/if}
    {#if model.unlisted}<Badge variant="secondary">unlisted</Badge>{/if}
    {#if model.isOfficial}<Badge variant="secondary">official</Badge>{/if}
    {#if model.status !== 'Published'}<Badge variant="secondary">{model.status}</Badge>{/if}
  </div>

  <p class="mt-1 text-sm text-dark-2">
    by
    <a href={userLookupUrl(model.username ?? model.userId)} class={LINK_CLASS}>
      {model.username ?? `#${model.userId}`}
    </a>
    {#if model.username}
      ·
      <a
        href={userUrl(civitaiUrl, model.username)}
        target="_blank"
        rel="noreferrer"
        class={LINK_CLASS}
      >
        profile
      </a>
    {/if}
    {#if model.userBannedAt}
      <Badge variant="destructive">author banned</Badge>
    {/if}
    ·
    <a href={bulkImageManagerUrl('model', model.id)} class={LINK_CLASS}>every image</a>
  </p>

  {#if model.deletedAt}
    <p class="mt-2 text-sm text-red-300">
      Deleted {dateTime(model.deletedAt)}{actor(model.deletedBy)
        ? ` by ${actor(model.deletedBy)}`
        : ''}.
    </p>
  {/if}

  <dl class="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
    {#each fields as [label, value] (label)}
      <div>
        <dt class="text-xs tracking-wide text-dark-2 uppercase">{label}</dt>
        <dd class="text-dark-0">{value}</dd>
      </div>
    {/each}
  </dl>

  <div class="mt-4 border-t border-dark-4 pt-4">
    <h3 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">License</h3>
    <div class="flex flex-wrap gap-x-8 gap-y-2 text-sm">
      {#each license as [label, value] (label)}
        <div>
          <span class="text-dark-0">{value}</span>
          <span class="ml-1 text-xs text-dark-2">{label.toLowerCase()}</span>
        </div>
      {/each}
    </div>
  </div>

  {#if modMeta.length}
    <div class="mt-4 border-t border-dark-4 pt-4">
      <h3 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Moderation record</h3>
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

  {#if model.lockedProperties.length}
    <div class="mt-4 border-t border-dark-4 pt-4">
      <h3 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Locked properties</h3>
      <div class="flex flex-wrap gap-1">
        {#each model.lockedProperties as prop (prop)}
          <Badge variant="secondary">{prop}</Badge>
        {/each}
      </div>
    </div>
  {/if}

  {#if hasMeta}
    <details class="mt-4 border-t border-dark-4 pt-4">
      <summary class="text-xs tracking-wide text-dark-2 uppercase">
        Meta (raw)
      </summary>
      <pre class="mt-2 overflow-x-auto rounded-md bg-dark-7 p-2 text-xs text-dark-0">{JSON.stringify(
          model.meta,
          null,
          2
        )}</pre>
    </details>
  {/if}
</section>
