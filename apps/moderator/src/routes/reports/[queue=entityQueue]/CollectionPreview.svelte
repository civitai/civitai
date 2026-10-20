<script lang="ts">
  import type { ReportActionGrants } from '$lib/report-queue';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import ImageEvidence from '$lib/components/report-queue/ImageEvidence.svelte';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { articleLookupUrl, bulkImageManagerUrl, entityUrl, modelLookupUrl } from '$lib/entity-url';
  import type { EntityEvidence } from '$lib/server/entity-queue-load';

  // A reported collection: what it is and who can see it, then what it holds. Most reported
  // collections are image collections, judged by looking at the images; posts, models and articles
  // are listed, each linked to where it can be opened and acted on.
  let {
    evidence,
    can,
    civitaiUrl,
  }: {
    evidence: Extract<EntityEvidence, { kind: 'collection' }>;
    can: ReportActionGrants;
    civitaiUrl: string;
  } = $props();

  const c = $derived(evidence.collection);

  type Other = (typeof evidence.others)[number];
  function describe(item: Other): { kind: string; label: string; href: string | null; external: boolean } {
    if (item.modelId != null)
      return { kind: 'Model', label: item.modelName ?? `#${item.modelId}`, href: modelLookupUrl(item.modelId), external: false };
    if (item.postId != null)
      return { kind: 'Post', label: item.postTitle || `#${item.postId}`, href: bulkImageManagerUrl('post', item.postId), external: false };
    if (item.articleId != null)
      return { kind: 'Article', label: item.articleTitle || `#${item.articleId}`, href: articleLookupUrl(item.articleId), external: false };
    if (item.model3dId != null)
      return { kind: '3D model', label: `#${item.model3dId}`, href: entityUrl(civitaiUrl, 'model3d', item.model3dId), external: true };
    return { kind: 'Item', label: `#${item.id}`, href: null, external: false };
  }
</script>

{#if c}
  <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
    <dt class="text-muted-foreground">Holds</dt>
    <dd class="m-0">
      {c.type ? `${c.type.toLowerCase()}s` : 'anything'}
      {#if c.mode}<Badge variant="secondary">{c.mode}</Badge>{/if}
    </dd>
    <dt class="text-muted-foreground">Visible to</dt>
    <dd class="m-0">
      {c.read}{c.availability !== 'Public' ? ` · ${c.availability}` : ''} · rated {getBrowsingLevelLabel(c.nsfwLevel)}
    </dd>
    <dt class="text-muted-foreground">Who can add</dt>
    <dd class="m-0">{c.write}</dd>
    <dt class="text-muted-foreground">Created</dt>
    <dd class="m-0">{dateTime(c.createdAt)}</dd>
    <dt class="text-muted-foreground">Description</dt>
    <dd class="m-0 whitespace-pre-wrap wrap-break-word">{c.description || '—'}</dd>
  </dl>

  {#if evidence.images && (evidence.images.total > 0 || evidence.othersTotal === 0)}
    <section aria-labelledby="collection-images" class="mt-5 flex flex-col gap-2">
      <h3 id="collection-images" class="m-0 text-sm font-semibold">
        Images <span class="font-normal text-muted-foreground">· {num(evidence.images.total)}</span>
      </h3>
      <!-- A collection holds other people's images. Removing one takes it off the site, not out of the
           collection — the owner who collected it is not the one who posted it. -->
      {#if can.images}
        <p class="m-0 text-xs text-muted-foreground">
          Removing an image takes it off the site for its poster, not just out of this collection.
        </p>
      {/if}
      <ImageEvidence
        images={evidence.images.items}
        {can}
        {civitaiUrl}
        empty="This collection holds nothing."
        truncated={evidence.images.truncated}
        paging={evidence.images}
        owners={evidence.images.owners}
      />
    </section>
  {/if}

  {#if evidence.othersTotal > 0}
    <section aria-labelledby="collection-items" class="mt-5 flex flex-col gap-2">
      <h3 id="collection-items" class="m-0 text-sm font-semibold">
        Items <span class="font-normal text-muted-foreground">· {num(evidence.othersTotal)}</span>
      </h3>
      {#if evidence.othersTotal > evidence.others.length}
        <p class="m-0 text-xs text-muted-foreground">
          The newest {num(evidence.others.length)}; the rest are
          <a href={entityUrl(civitaiUrl, 'collection', c.id)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
            on the site
          </a>.
        </p>
      {/if}
      <ul class="m-0 flex list-none flex-col divide-y rounded-lg border p-0 text-sm">
        {#each evidence.others as item (item.id)}
          {@const d = describe(item)}
          <li class="flex flex-wrap items-baseline gap-x-2 px-3 py-2">
            <span class="text-xs text-muted-foreground">{d.kind}</span>
            {#if d.href}
              <a
                href={d.href}
                class="{LINK_CLASS} wrap-break-word"
                target={d.external ? '_blank' : undefined}
                rel={d.external ? 'noreferrer' : undefined}
              >
                {d.label}
              </a>
            {:else}
              <span>{d.label}</span>
            {/if}
            {#if item.status !== 'ACCEPTED'}<Badge variant="secondary">{item.status.toLowerCase()}</Badge>{/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/if}
