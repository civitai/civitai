<script lang="ts">
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import { Card, CardHeader, CardTitle, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import type { PageData } from './$types';
  import type { CreatorModel } from '$lib/server/models';

  let { data }: { data: PageData } = $props();

  const feeLabel = (fee: number | null) => (fee == null ? 'Off' : `${fee} ⚡ / image`);

  // Bulk mode is URL-driven (`?mode=bulk`) so it's linkable and the back button exits it.
  const bulkMode = $derived(data.canSetFee && page.url.searchParams.get('mode') === 'bulk');

  // Selection (reassigned on each change so Svelte tracks it) + bulk-bar feedback.
  let selected = $state<Set<number>>(new Set());
  let bulkFee = $state('');
  let bulkError = $state('');
  let bulkUpdated = $state<number | null>(null);

  // Per-version inline feedback for single-edit mode.
  let errors = $state<Record<number, string>>({});
  let saved = $state<Record<number, boolean>>({});

  function toggleVersion(id: number) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    selected = next;
  }

  function modelIds(model: CreatorModel) {
    return model.versions.map((v) => v.id);
  }
  function allSelected(model: CreatorModel) {
    return model.versions.length > 0 && modelIds(model).every((id) => selected.has(id));
  }
  function toggleModel(model: CreatorModel) {
    const next = new Set(selected);
    const all = allSelected(model);
    for (const id of modelIds(model)) (all ? next.delete(id) : next.add(id));
    selected = next;
  }
</script>

<header class="page-header flex items-start gap-3">
  <div>
    <h1>Models</h1>
    <p>Set licensing fees, manage early/paid access, and sell access indefinitely — per version.</p>
  </div>
  {#if data.canSetFee && data.models.length > 0}
    <a
      href={bulkMode ? '/models' : '/models?mode=bulk'}
      class="ml-auto rounded-md border border-dark-4 bg-dark-6 px-3 py-1.5 text-sm text-white hover:border-dark-3"
    >
      {bulkMode ? 'Done' : 'Bulk edit fees'}
    </a>
  {/if}
</header>

{#if !data.canSetFee}
  <div class="mb-6 rounded-lg border border-dark-4 bg-dark-6 p-4 text-sm text-dark-1">
    Setting licensing fees requires <a href="/join">Creator Program membership</a>. You can still review your
    models below.
  </div>
{/if}

{#if bulkMode && selected.size > 0}
  <form
    method="POST"
    action="?/bulkSetFee"
    class="sticky top-2 z-10 mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-blue-8/40 bg-dark-6 p-3 shadow-lg"
    use:enhance={({ cancel }) => {
      if (!confirm(`Apply this fee to ${selected.size} version(s)? This changes what creators are charged.`)) {
        cancel();
        return;
      }
      bulkError = '';
      bulkUpdated = null;
      return async ({ result, update }) => {
        await update({ reset: false });
        if (result.type === 'success') {
          bulkUpdated = Number((result.data as { updated?: number })?.updated ?? 0);
          selected = new Set();
        } else if (result.type === 'failure') {
          bulkError = String((result.data as { error?: string })?.error ?? 'Failed');
        }
      };
    }}
  >
    <span class="text-sm font-medium text-white">{selected.size} selected</span>
    <input type="hidden" name="versionIds" value={[...selected].join(',')} />
    <input
      type="number"
      name="fee"
      step="0.01"
      min="0"
      max="100"
      bind:value={bulkFee}
      placeholder="⚡ / image (empty = clear)"
      class="w-52 rounded border border-dark-4 bg-dark-7 px-2 py-1 text-sm text-white"
    />
    <button
      type="submit"
      class="rounded bg-blue-8 px-3 py-1 text-sm font-medium text-white hover:bg-blue-7"
    >
      Apply to {selected.size}
    </button>
    {#if bulkError}
      <span class="text-xs text-red-4">{bulkError}</span>
    {:else if bulkUpdated != null}
      <span class="text-xs text-green-5">Updated {bulkUpdated} version{bulkUpdated === 1 ? '' : 's'}</span>
    {/if}
  </form>
{/if}

{#if data.models.length === 0}
  <div class="placeholder">
    You have no models yet. <a href="https://civitai.com/models/create">Upload one on civitai.com</a> to get started.
  </div>
{:else}
  <div class="flex flex-col gap-5">
    {#each data.models as model (model.id)}
      <Card>
        <CardHeader class="flex-row items-center gap-3">
          {#if bulkMode && model.versions.length > 0}
            <input
              type="checkbox"
              checked={allSelected(model)}
              onchange={() => toggleModel(model)}
              aria-label="Select all versions of {model.name}"
              class="size-4"
            />
          {/if}
          <CardTitle class="text-base text-white">{model.name}</CardTitle>
          <Badge variant="secondary">{model.type}</Badge>
          <Badge variant="outline" class="ml-auto">{model.status}</Badge>
        </CardHeader>
        <CardContent>
          {#if model.versions.length === 0}
            <p class="text-sm text-dark-3">No versions.</p>
          {:else}
            <Table>
              <TableHeader>
                <TableRow>
                  {#if bulkMode}<TableHead class="w-8"></TableHead>{/if}
                  <TableHead>Version</TableHead>
                  <TableHead>Base model</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Licensing fee (⚡ / image)</TableHead>
                  <TableHead>Access</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {#each model.versions as version (version.id)}
                  <TableRow>
                    {#if bulkMode}
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={selected.has(version.id)}
                          onchange={() => toggleVersion(version.id)}
                          aria-label="Select {version.name}"
                          class="size-4"
                        />
                      </TableCell>
                    {/if}
                    <TableCell class="font-medium text-white">{version.name}</TableCell>
                    <TableCell class="text-dark-2">{version.baseModel}</TableCell>
                    <TableCell>
                      <Badge variant={version.status === 'Published' ? 'default' : 'outline'}>
                        {version.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {#if data.canSetFee && !bulkMode}
                        <form
                          method="POST"
                          action="?/setFee"
                          class="flex items-center gap-2"
                          use:enhance={() => {
                            errors[version.id] = '';
                            saved[version.id] = false;
                            return async ({ result, update }) => {
                              await update({ reset: false });
                              if (result.type === 'success') saved[version.id] = true;
                              else if (result.type === 'failure')
                                errors[version.id] = String(
                                  (result.data as { error?: string })?.error ?? 'Failed'
                                );
                            };
                          }}
                        >
                          <input type="hidden" name="versionId" value={version.id} />
                          <input
                            type="number"
                            name="fee"
                            step="0.01"
                            min="0"
                            max="100"
                            value={version.licensingFee ?? ''}
                            placeholder="Off"
                            class="w-24 rounded border border-dark-4 bg-dark-7 px-2 py-1 text-sm text-white"
                          />
                          <button
                            type="submit"
                            class="rounded bg-blue-8 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-7"
                          >
                            Save
                          </button>
                          {#if errors[version.id]}
                            <span class="text-xs text-red-4">{errors[version.id]}</span>
                          {:else if saved[version.id]}
                            <span class="text-xs text-green-5">Saved</span>
                          {/if}
                        </form>
                      {:else}
                        <span class="text-dark-1">{feeLabel(version.licensingFee)}</span>
                      {/if}
                    </TableCell>
                    <TableCell class="text-dark-2">
                      {version.hasEarlyAccess ? 'Early access' : '—'}
                    </TableCell>
                  </TableRow>
                {/each}
              </TableBody>
            </Table>
          {/if}
        </CardContent>
      </Card>
    {/each}
  </div>
{/if}
