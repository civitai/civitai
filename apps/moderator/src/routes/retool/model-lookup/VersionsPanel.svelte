<script lang="ts">
  import { getBrowsingLevelLabel, getModelVersionFlagLabels } from '@civitai/shared';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { bulkImageManagerUrl, modelVersionUrl } from '$lib/entity-url';
  import { humanizeUnpublishReason } from '$lib/articles';
  import { LINK_CLASS, dateTime, num, plural } from '$lib/format';
  import type { PageData } from './$types';

  type Result = NonNullable<PageData['result']>;

  let {
    modelId,
    versions,
    highlightVersionId,
    actors,
    civitaiUrl,
  }: {
    modelId: number;
    versions: Result['versions'];
    highlightVersionId: number | null;
    actors: Result['actors'];
    civitaiUrl: string;
  } = $props();

  /**
   * A version carries its own unpublish record, and a version can be unpublished while the model stays
   * published — so this is the only place that decision appears. Same `meta`-may-not-be-an-object narrow
   * as the model panel.
   */
  const unpublish = (meta: unknown) => {
    const m =
      meta && typeof meta === 'object' && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)
        : {};
    if (!m.unpublishedAt && !m.unpublishedReason) return null;
    const by = typeof m.unpublishedBy === 'number' ? (actors[m.unpublishedBy] ?? `#${m.unpublishedBy}`) : null;
    return {
      reason:
        typeof m.unpublishedReason === 'string' ? humanizeUnpublishReason(m.unpublishedReason) : null,
      at: typeof m.unpublishedAt === 'string' ? m.unpublishedAt : null,
      by,
      message: typeof m.customMessage === 'string' ? m.customMessage : null,
    };
  };
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-3 text-sm font-semibold text-white">
    Versions ({num(versions.length)})
  </h3>

  {#if versions.length === 0}
    <p class="text-sm text-dark-2">No versions. Nothing has ever been uploaded under this model.</p>
  {:else}
    <ul class="space-y-3">
      {#each versions as v (v.id)}
        {@const u = unpublish(v.meta)}
        <li
          class="rounded-lg border p-3 {v.id === highlightVersionId
            ? 'border-blue-500/40 bg-blue-500/5'
            : 'border-dark-4'}"
        >
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <a
              href={modelVersionUrl(civitaiUrl, modelId, v.id)}
              target="_blank"
              rel="noreferrer"
              class="font-medium {LINK_CLASS}"
            >
              {v.name}
            </a>
            <code class="text-xs text-dark-2">#{v.id}</code>
            <Badge variant="secondary">{v.baseModel}</Badge>
            {#if v.baseModelType !== 'Standard'}
              <Badge variant="secondary">{v.baseModelType}</Badge>
            {/if}
            <Badge variant={v.nsfwLevel > 1 ? 'destructive' : 'secondary'}>
              {getBrowsingLevelLabel(v.nsfwLevel)}
            </Badge>
            {#if v.status !== 'Published'}<Badge variant="secondary">{v.status}</Badge>{/if}
            {#if v.availability !== 'Public'}<Badge variant="secondary">{v.availability}</Badge>{/if}
            {#if v.trainingStatus}<Badge variant="secondary">training: {v.trainingStatus}</Badge>{/if}
            {#each getModelVersionFlagLabels(v.flags) as label (label)}
              <Badge variant="destructive">{label}</Badge>
            {/each}
            {#if v.generatorLoaded}<Badge variant="secondary">generator loaded</Badge>{/if}
            {#if v.requireAuth}<Badge variant="secondary">auth required</Badge>{/if}
            {#if v.earlyAccessTimeFrame > 0}
              <Badge variant="secondary">early access {v.earlyAccessTimeFrame}d</Badge>
            {/if}
            {#if v.usageControl !== 'Download'}
              <Badge variant="secondary">{v.usageControl}</Badge>
            {/if}
          </div>

          <p class="mt-1 flex flex-wrap gap-x-3 text-xs text-dark-2">
            <span>created {dateTime(v.createdAt)}</span>
            <span>published {dateTime(v.publishedAt)}</span>
            <span>{plural(v.fileCount, 'file')}</span>
            {#if v.dangerFileCount > 0}
              <span class="font-semibold text-red-400">
                {plural(v.dangerFileCount, 'file')} flagged DANGEROUS
              </span>
            {/if}
            {#if v.unscannedFileCount > 0}
              <span class="text-amber-300">
                {plural(v.unscannedFileCount, 'file')} not scanned clean
              </span>
            {/if}
            <a href={bulkImageManagerUrl('modelVersion', v.id)} class={LINK_CLASS}>
              {v.imageCountCapped
                ? `${num(v.imageCount)}+ images`
                : plural(v.imageCount, 'image')}
            </a>
          </p>

          {#if u}
            <p class="mt-1 text-xs wrap-break-word text-amber-300">
              Unpublished{u.reason ? `: ${u.reason}` : ''}{u.at ? ` · ${dateTime(u.at)}` : ''}{u.by
                ? ` · by ${u.by}`
                : ''}{u.message ? ` · "${u.message}"` : ''}
            </p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
