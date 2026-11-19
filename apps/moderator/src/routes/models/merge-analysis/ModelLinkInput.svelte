<script lang="ts">
  import { browser } from '$app/environment';
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { modelVersionUrl } from '$lib/entity-url';
  import { fetchJson } from '$lib/fetch-json';
  import { LINK_CLASS } from '$lib/format';
  import { MERGE_ANALYSIS_PATH, type ModelRole, type ResolveResponse } from '$lib/model-merge-analysis';

  let {
    id,
    label,
    hint,
    role,
    name,
    labelName,
    hashName,
  }: {
    id: string;
    label: string;
    hint: string;
    role: ModelRole;
    /** Form fields carrying the chosen AIR, its display name and, when given, its file hash. */
    name: string;
    labelName: string;
    hashName?: string;
  } = $props();

  let link = $state('');
  let lookedUp = $state('');
  let version = $state(0);
  let chosen = $state<number | null>(null);

  const lookup = $derived(
    browser && lookedUp
      ? fetchJson<ResolveResponse>(
          `${MERGE_ANALYSIS_PATH}/resolve?${new URLSearchParams({ link: lookedUp, role, v: String(version) })}`
        )
      : null
  );
  // An edited link no longer matches the lookup shown, so it must not be submitted under it.
  const current = $derived(link.trim() !== '' && link.trim() === lookedUp);

  function look() {
    chosen = null;
    lookedUp = link.trim();
    version++;
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
      <p class="text-sm text-dark-2">Looking up the link…</p>
    {:then res}
      {#if 'error' in res}
        <p class="text-sm text-red-300" role="alert">{res.error}</p>
      {:else}
        {@const picked =
          res.versions.find((v) => v.versionId === chosen) ??
          res.versions.find((v) => v.air) ??
          res.versions[0]}
        <div class="rounded-md border border-dark-4 bg-dark-7 p-3 text-sm">
          <p>
            <a
              class={LINK_CLASS}
              href={modelVersionUrl(page.data.civitaiUrl, picked.modelId, picked.versionId)}
              target="_blank"
              rel="noreferrer">{picked.modelName}</a
            >
          </p>
          {#if res.versions.length > 1}
            <div class="mt-2 flex flex-wrap items-center gap-2 text-dark-2">
              <Label for="{id}-version" class="text-dark-2">Version</Label>
              <Select.Root
                type="single"
                bind:value={() => String(picked.versionId), (v) => (chosen = v ? Number(v) : null)}
              >
                <Select.Trigger id="{id}-version" class="w-64">{picked.versionName}</Select.Trigger>
                <Select.Content>
                  {#each res.versions as v (v.versionId)}
                    <Select.Item value={String(v.versionId)}
                      >{v.versionName}{v.air ? '' : ' (no readable file)'}</Select.Item
                    >
                  {/each}
                </Select.Content>
              </Select.Root>
            </div>
          {:else}
            <p class="text-dark-2">Version: {picked.versionName}</p>
          {/if}
          <p class="mt-1 text-xs text-dark-2">
            {picked.baseModel}{picked.fileName ? ` · ${picked.fileName}` : ''}
          </p>
          {#if picked.air}
            <input type="hidden" {name} value={picked.air} />
            <input
              type="hidden"
              name={labelName}
              value={`${picked.modelName} — ${picked.versionName}`.slice(0, 300)}
            />
            {#if hashName}
              <input type="hidden" name={hashName} value={picked.sha256 ?? ''} />
            {/if}
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
