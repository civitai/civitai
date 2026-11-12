<script lang="ts">
  import { browser } from '$app/environment';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { fetchJson } from '$lib/fetch-json';
  import { MERGE_ANALYSIS_PATH, type ModelRole, type ResolveResponse } from '$lib/model-merge-analysis';

  let {
    id,
    label,
    hint,
    role,
    name,
    labelName,
  }: {
    id: string;
    label: string;
    hint: string;
    role: ModelRole;
    /** Form field carrying the chosen AIR, and the one carrying its display name. */
    name: string;
    labelName: string;
  } = $props();

  let link = $state('');
  let lookedUp = $state('');
  let chosen = $state<number | null>(null);

  const lookup = $derived(
    browser && lookedUp
      ? fetchJson<ResolveResponse>(
          `${MERGE_ANALYSIS_PATH}/resolve?${new URLSearchParams({ link: lookedUp, role })}`
        )
      : null
  );
  // An edited link no longer matches the lookup shown, so it must not be submitted under it.
  const current = $derived(link.trim() !== '' && link.trim() === lookedUp);

  function look() {
    chosen = null;
    lookedUp = link.trim();
  }
</script>

<div class="flex flex-col gap-1.5">
  <Label for={id} class="text-white">{label}</Label>
  <p class="text-xs text-dark-2">{hint}</p>
  <div class="flex gap-2">
    <Input
      {id}
      bind:value={link}
      placeholder="https://civitai.com/models/… or urn:air:…"
      autocomplete="off"
      onkeydown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          look();
        }
      }}
      onblur={() => link.trim() && link.trim() !== lookedUp && look()}
    />
    <Button type="button" variant="outline" onclick={look} disabled={!link.trim()}>Look up</Button>
  </div>

  {#if lookup && current}
    {#await lookup}
      <p class="text-sm text-dark-2">Looking up…</p>
    {:then res}
      {#if 'error' in res}
        <p class="text-sm text-red-300" role="alert">{res.error}</p>
      {:else}
        {@const picked =
          res.versions.find((v) => v.versionId === chosen) ??
          res.versions.find((v) => v.air) ??
          res.versions[0]}
        <div class="rounded-md border border-dark-4 bg-dark-7 p-3 text-sm">
          <p class="text-white">
            <a
              class="underline-offset-2 hover:underline"
              href="https://civitai.com/models/{picked.modelId}?modelVersionId={picked.versionId}"
              target="_blank"
              rel="noreferrer">{picked.modelName}</a
            >
          </p>
          {#if res.versions.length > 1}
            <label class="mt-2 flex flex-wrap items-center gap-2 text-dark-2">
              Version
              <select
                class="rounded bg-dark-5 px-2 py-1 text-dark-0"
                bind:value={() => picked.versionId, (v) => (chosen = v)}
              >
                {#each res.versions as v (v.versionId)}
                  <option value={v.versionId}>{v.versionName}{v.air ? '' : ' (no readable file)'}</option>
                {/each}
              </select>
            </label>
          {:else}
            <p class="text-dark-2">Version: {picked.versionName}</p>
          {/if}
          <p class="mt-1 text-xs text-dark-2">
            {picked.baseModel}{picked.fileName ? ` · ${picked.fileName}` : ''}
          </p>
          {#if picked.air}
            <input type="hidden" {name} value={picked.air} />
            <input type="hidden" name={labelName} value="{picked.modelName} — {picked.versionName}" />
          {:else}
            <p class="mt-1 text-red-300" role="alert">{picked.problem}</p>
          {/if}
        </div>
      {/if}
    {:catch e}
      <p class="text-sm text-red-300" role="alert">
        Could not look this link up: {e instanceof Error ? e.message : 'unknown error'}. Try again.
      </p>
    {/await}
  {/if}
</div>
