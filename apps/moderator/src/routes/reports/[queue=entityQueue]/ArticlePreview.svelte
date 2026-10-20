<script lang="ts">
  import type { ReportActionGrants } from '$lib/report-queue';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import ImageFlagBadges from '$lib/components/ImageFlagBadges.svelte';
  import ImageEvidence from '$lib/components/report-queue/ImageEvidence.svelte';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { entityUrl } from '$lib/entity-url';
  import { articleStatusBadge, type ArticleMetadata } from '$lib/articles';
  import { articleUnpublishReasonLabel } from '$lib/article-unpublish-reasons';
  import type { EntityEvidence } from '$lib/server/entity-queue-load';

  // A reported article: how it is shown, what it says with its images in place, and every image again
  // as a grid — the cover and the body's, the ones that decide its rating — to act on.
  let {
    evidence,
    can,
    civitaiUrl,
  }: {
    evidence: Extract<EntityEvidence, { kind: 'article' }>;
    can: ReportActionGrants;
    civitaiUrl: string;
  } = $props();

  const a = $derived(evidence.article);
  const meta = $derived<NonNullable<ArticleMetadata>>((a?.metadata as ArticleMetadata) ?? {});
  // An inline image is one of the article's connected images; finding it there shows its flags and
  // links it, so an image already removed reads as removed where it sits in the text. Only those are
  // drawn: a media tag naming anything else is the author's value, not an upload, and is not loaded.
  type Img = NonNullable<typeof evidence.images>['items'][number];
  const byUrl = $derived(new Map((evidence.images?.items ?? []).map((i) => [i.url, i])));
  // Reset with the item: the page renders this under `{#key}`.
  let shownExternal = $state<Record<number, boolean>>({});

</script>

{#snippet media(img: Img)}
  <figure class="m-0 flex flex-col gap-1">
    <a
      href={entityUrl(civitaiUrl, 'image', img.id)}
      target="_blank"
      rel="noreferrer"
      class="block max-w-md overflow-hidden rounded-md bg-muted"
    >
      <EdgeMedia src={img.url} type={img.type} width={450} class="max-h-112 max-w-full object-contain" />
    </a>
    <figcaption class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
      <Badge variant="secondary">rated {getBrowsingLevelLabel(img.nsfwLevel)}</Badge>
      <ImageFlagBadges
        ingestion={img.ingestion}
        blockedFor={img.blockedFor}
        tosViolation={img.tosViolation}
        needsReview={img.needsReview}
        poi={img.poi}
        minor={img.minor}
        approvedAppeal={img.approvedAppeal}
      />
    </figcaption>
  </figure>
{/snippet}

{#if a}
  {@const cover = a.coverId != null ? evidence.images?.items.find((i) => i.id === a.coverId) : undefined}
  <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
    <dt class="text-muted-foreground">Status</dt>
    <dd class="m-0 flex flex-wrap items-center gap-2">
      {#if articleStatusBadge[a.status]}
        <Badge class={articleStatusBadge[a.status].class}>{articleStatusBadge[a.status].label}</Badge>
      {:else}
        {a.status}
      {/if}
      {#if a.tosViolation}<Badge variant="destructive">ToS'd</Badge>{/if}
      {#if a.publishedAt}
        <span class="text-muted-foreground">published {dateTime(a.publishedAt)}</span>
      {/if}
    </dd>
    {#if meta.unpublishedReason}
      <dt class="text-muted-foreground">Unpublished for</dt>
      <dd class="m-0 wrap-break-word">
        {articleUnpublishReasonLabel(meta.unpublishedReason)}{meta.unpublishedAt
          ? ` · ${dateTime(new Date(meta.unpublishedAt))}`
          : ''}
        {#if meta.customMessage}
          <span class="block text-muted-foreground">“{meta.customMessage}”</span>
        {/if}
      </dd>
    {/if}
    <dt class="text-muted-foreground">Shown</dt>
    <dd class="m-0">
      {a.availability}{a.unlisted ? ', unlisted' : ''} · rated {getBrowsingLevelLabel(a.nsfwLevel)}
      {#if a.moderatorNsfwLevel != null}
        <span class="text-muted-foreground">(rating set by a moderator)</span>
      {/if}
    </dd>
    <dt class="text-muted-foreground">Scan</dt>
    <dd class="m-0">{a.ingestion}</dd>
    <dt class="text-muted-foreground">Created</dt>
    <dd class="m-0">{dateTime(a.createdAt)}</dd>
  </dl>

  <section aria-labelledby="article-body" class="mt-5 flex flex-col gap-2">
    <h3 id="article-body" class="m-0 text-sm font-semibold">Text</h3>
    {#if evidence.body || cover}
      <!-- As text, never as HTML: the body is author-written markup, and this page runs in a
           moderator's session. Images sit where the author put them; formatting is on the site. -->
      <div class="flex max-h-192 flex-col gap-3 overflow-y-auto rounded-lg border p-3 text-sm">
        <!-- The cover opens the text, as it opens the article on the site. -->
        {#if cover}{@render media(cover)}{/if}
        {#each evidence.body?.segments ?? [] as seg, i (i)}
          {#if seg.kind === 'text'}
            <p class="m-0 whitespace-pre-wrap wrap-break-word">{seg.text}</p>
          {:else if seg.kind === 'media'}
            {@const img = byUrl.get(seg.url)}
            {#if img}
              {@render media(img)}
            {:else}
              <p class="m-0 rounded-md border border-dashed p-2 text-xs text-muted-foreground">
                A {seg.mediaType} that is not one of this article's uploads, so it is not shown.
              </p>
            {/if}
          {:else if seg.kind === 'external'}
            <!-- Another site's image: loading it would hand that site the moderator's address, so it
                 waits for a click. -->
            <div class="flex flex-col gap-1 rounded-md border border-dashed p-2 text-xs">
              <span class="text-muted-foreground">
                Image from {new URL(seg.src).host}{seg.alt ? ` — “${seg.alt}”` : ''}
              </span>
              {#if shownExternal[i]}
                <img src={seg.src} alt={seg.alt ?? ''} class="max-h-112 max-w-md object-contain" />
              {:else}
                <button type="button" class="{LINK_CLASS} self-start" onclick={() => (shownExternal[i] = true)}>
                  Load it
                </button>
              {/if}
            </div>
          {:else}
            <p class="m-0 rounded-md border border-dashed p-2 text-xs text-muted-foreground">
              Embedded from {new URL(seg.src).host}:
              <a href={seg.src} target="_blank" rel="noreferrer" class="{LINK_CLASS} break-all">{seg.src}</a>
            </p>
          {/if}
        {/each}
      </div>
      {#if evidence.body?.truncated}
        <p class="m-0 text-xs text-muted-foreground">
          The rest is
          <a href={entityUrl(civitaiUrl, 'article', a.id)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
            on the site
          </a>.
        </p>
      {/if}
    {:else}
      <p class="m-0 text-sm text-muted-foreground">No text.</p>
    {/if}
  </section>

  {#if evidence.images}
    <section aria-labelledby="article-images" class="mt-5 flex flex-col gap-2">
      <h3 id="article-images" class="m-0 text-sm font-semibold">
        Images
        <span class="font-normal text-muted-foreground">· {num(evidence.images.total)}, the cover included</span>
      </h3>
      <ImageEvidence
        images={evidence.images.items}
        {can}
        {civitaiUrl}
        empty="This article has no images."
        truncated={evidence.images.truncated}
      />
    </section>
  {/if}
{/if}
