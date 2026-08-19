<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import BanConfirmForm from '$lib/components/BanConfirmForm.svelte';
  import EdgeImage from '$lib/components/EdgeImage.svelte';
  import TrainingDataSheet from './TrainingDataSheet.svelte';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, bytes, dateTime } from '$lib/format';
  import { userLookupUrl, modelVersionUrl } from '$lib/entity-url';
  import type { TrainingFeedModel } from '$lib/server/training-moderation.service';

  let {
    model,
    civitaiUrl,
    canBan,
  }: {
    model: TrainingFeedModel;
    civitaiUrl: string;
    canBan: boolean;
  } = $props();

  let banning = $state(false);
  let viewing = $state<TrainingFeedModel['versions'][number] | null>(null);
  let viewerOpen = $state(false);

  // `onSubmit`, not `onSuccess`: the reload lands first, so by then `model.cannotPublish` already
  // holds the new value and naming it there announces the opposite of what the moderator just did.
  let blockedBefore = $state(false);
  const publish = new FormState({
    onSubmit: () => (blockedBefore = model.cannotPublish),
    reload: true,
    onSuccess: () => toast.success(blockedBefore ? 'Publishing allowed' : 'Publishing blocked'),
  });

  const ban = new FormState({
    onSuccess: () => {
      banning = false;
      toast.success(`Banned ${model.username ?? model.userId}`);
    },
  });

  const openViewer = (version: TrainingFeedModel['versions'][number]) => {
    viewing = version;
    viewerOpen = true;
  };
</script>

<article class="flex flex-col gap-3 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="flex items-start justify-between gap-3">
    <a
      href="{civitaiUrl}/models/{model.id}"
      target="_blank"
      rel="noreferrer"
      class="{LINK_CLASS} line-clamp-2 font-semibold"
    >
      {model.name}
    </a>
    <a
      href={userLookupUrl(model.username ?? model.userId)}
      class="{LINK_CLASS} flex shrink-0 items-center gap-1.5 text-xs"
    >
      {#if model.userImage}
        <EdgeImage src={model.userImage} width={32} class="size-5 rounded-full" alt="" />
      {/if}
      {model.username ?? `#${model.userId}`}
    </a>
  </div>

  <div class="flex flex-wrap gap-1.5">
    <Badge variant={model.status === 'Published' ? 'secondary' : 'outline'}>{model.status}</Badge>
    <Badge variant="outline">{model.type}</Badge>
    {#if model.nsfw}<Badge variant="secondary" class="bg-orange-500/20 text-orange-200">NSFW</Badge>{/if}
    {#if model.poi}<Badge variant="destructive">POI</Badge>{/if}
    {#if model.minor}<Badge variant="destructive">Minor</Badge>{/if}
    {#if model.tosViolation}<Badge variant="destructive">ToS</Badge>{/if}
    {#if model.cannotPublish}<Badge variant="destructive">Blocked</Badge>{/if}
  </div>

  <p class="text-xs text-dark-2">
    Created {dateTime(model.createdAt)}{model.publishedAt
      ? ` · Published ${dateTime(model.publishedAt)}`
      : ''}
  </p>

  {#if publish.error ?? ban.error}
    <p class="text-sm text-red-300">{publish.error ?? ban.error}</p>
  {/if}

  <div class="flex flex-wrap items-center gap-2">
    <form method="POST" action="?/toggleCannotPublish" use:enhance={publish.enhance}>
      <input type="hidden" name="modelId" value={model.id} />
      <Button
        type="submit"
        size="sm"
        variant={model.cannotPublish ? 'destructive' : 'outline'}
        disabled={publish.submitting}
      >
        {model.cannotPublish ? 'Allow publish' : 'Block publish'}
      </Button>
    </form>
    {#if canBan}
      <Button size="sm" variant="outline" onclick={() => (banning = !banning)}>Ban</Button>
    {/if}
  </div>

  {#if banning}
    <BanConfirmForm
      userId={model.userId}
      username={model.username}
      enhancer={ban.enhance}
      busy={ban.submitting}
      onCancel={() => (banning = false)}
    >
      {#snippet hidden()}
        <input type="hidden" name="modelId" value={model.id} />
      {/snippet}
    </BanConfirmForm>
  {/if}

  {#each model.versions as version (version.id)}
    <div class="rounded-lg border border-dark-4 bg-dark-7 p-3">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="truncate text-sm font-medium text-dark-0">{version.name}</p>
          <p class="text-xs text-dark-2">Created {dateTime(version.createdAt)}</p>
        </div>
        <div class="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="outline"
            href={modelVersionUrl(civitaiUrl, model.id, version.id)}
            target="_blank"
            rel="noreferrer"
          >
            View
          </Button>
          <Button size="sm" variant="outline" onclick={() => openViewer(version)}>Images</Button>
          <Button size="sm" href="/audit/training-data/{version.id}">Review</Button>
        </div>
      </div>

      <div class="mt-2 flex flex-wrap gap-1.5">
        <Badge variant="outline">{version.status}</Badge>
        {#if version.baseModel}<Badge variant="outline">{version.baseModel}</Badge>{/if}
        {#if version.trainingStatus}<Badge variant="secondary">{version.trainingStatus}</Badge>{/if}
      </div>

      {#each version.files as file (file.id)}
        <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-dark-2">
          <span class="truncate text-dark-0">{file.name}</span>
          <span>{bytes(file.sizeKB)}</span>
          <span>{dateTime(file.createdAt)}</span>
          {#if file.numImages}<Badge variant="outline">{file.numImages} img</Badge>{/if}
          {#if file.numCaptions}<Badge variant="outline">{file.numCaptions} cap</Badge>{/if}
          <Button size="sm" variant="outline" href="/api/training-data/{version.id}" download>
            Download
          </Button>
        </div>
      {/each}
    </div>
  {/each}
</article>

{#if viewing}
  <!-- Keyed so a close-then-open onto a DIFFERENT version cannot show the previous one's header. -->
  {#key viewing.id}
    <TrainingDataSheet
    bind:open={viewerOpen}
    versionId={viewing.id}
    title="{model.name} — {viewing.name}"
      badges={[model.type, viewing.status, viewing.baseModel]}
    />
  {/key}
{/if}
