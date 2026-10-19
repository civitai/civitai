<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import type { FormState } from '$lib/form-state.svelte';
  import { num } from '$lib/format';
  import type { FixTarget, FlowNote, FlowProblem, TeamOdds } from '$lib/box-flow';
  import { ITEM_DEFINITION_STATUS, type BoxDraft } from '$lib/mystery-box';
  import StatusPanel from '../StatusPanel.svelte';
  import OddsTable from './OddsTable.svelte';

  let {
    box,
    draft,
    snapshots,
    civitaiUrl,
    dirty,
    problems,
    passed,
    odds,
    designs,
    saving,
    onfix,
  }: {
    box: { id: number; status: string; version: number };
    draft: BoxDraft;
    snapshots: { version: number; createdAt: Date; createdById: number | null }[];
    civitaiUrl: string;
    dirty: boolean;
    problems: FlowProblem[];
    passed: FlowNote[];
    odds: TeamOdds[];
    designs: number;
    saving: FormState;
    onfix: (fix: FixTarget) => void;
  } = $props();

  const isDraft = $derived(box.status === ITEM_DEFINITION_STATUS.draft);
  const rows = $derived(draft.contents.filter((content) => content.enabled).length);
</script>

<div class="grid max-w-[1100px] items-start gap-4 xl:grid-cols-2">
  <div class="space-y-4 xl:col-span-2">
    <StatusPanel {box} {snapshots} {civitaiUrl} {dirty} />
  </div>

  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-1 text-base font-semibold text-white">{isDraft ? 'Publish checklist' : 'Checklist'}</h2>
    <p class="mb-2 text-xs text-dark-2">
      {#if problems.length}
        {isDraft ? 'Fix these to publish. A draft saves anyway.' : 'A published box saves only once these are fixed.'}
      {:else}
        Everything checks out.
      {/if}
    </p>
    <ul>
      {#each problems as problem, i (`${i}:${problem.message}`)}
        <li class="grid grid-cols-[22px_1fr_auto] items-start gap-2 border-t border-dark-4 py-2 first:border-t-0">
          <span class="mt-0.5 grid size-5 place-items-center rounded-full bg-red-500/15 text-xs text-red-300" aria-hidden="true">!</span>
          <span class="text-sm text-red-300">{problem.message}</span>
          {#if problem.fix}
            {@const fix = problem.fix}
            <Button size="sm" variant="outline" onclick={() => onfix(fix)}>Fix</Button>
          {/if}
        </li>
      {/each}
      {#each passed as note (note.message)}
        <li class="grid grid-cols-[22px_1fr] items-start gap-2 border-t border-dark-4 py-2">
          <span class="mt-0.5 grid size-5 place-items-center rounded-full text-xs {note.info ? 'bg-dark-5 text-dark-1' : 'bg-green-500/15 text-green-400'}" aria-hidden="true">{note.info ? 'i' : '✓'}</span>
          <span class="text-sm text-dark-0">{note.message}</span>
        </li>
      {/each}
    </ul>
  </section>

  <div class="space-y-4">
    <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <h2 class="mb-2 text-base font-semibold text-white">Odds by team</h2>
      <OddsTable {odds} />
    </section>
    <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <h2 class="mb-2 text-base font-semibold text-white">Summary</h2>
      <dl class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
        <dt class="text-dark-2">Name</dt><dd class="text-right text-white">{draft.name.trim() || '—'}</dd>
        <dt class="text-dark-2">Event</dt><dd class="text-right text-white">{draft.event || 'none'}</dd>
        <dt class="text-dark-2">Tiers</dt><dd class="text-right text-white">{draft.tiers.length}</dd>
        <dt class="text-dark-2">Designs</dt><dd class="text-right text-white">{num(designs)}</dd>
        <dt class="text-dark-2">Items switched on</dt><dd class="text-right text-white">{num(rows)}</dd>
      </dl>
    </section>
    <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <p class="mb-3 text-xs text-dark-2">
        {#if isDraft}
          Publishing writes the odds history's first entry (version 1). A draft is shown nowhere. A save is one write: if anything is refused, nothing changes.
        {:else}
          Saving a change to tiers, weights, contents or the event starts a new version and adds it to the public odds history.
        {/if}
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <Button type="submit" form="box-save" variant={isDraft ? 'outline' : 'default'} disabled={saving.submitting || !dirty}>Save</Button>
        {#if isDraft}
          <Button type="submit" form="box-save" formaction="?/publish" disabled={saving.submitting || problems.length > 0}>
            {dirty ? 'Save and publish' : 'Publish'}
          </Button>
        {/if}
        {#if dirty}<span class="text-xs text-amber-300">Unsaved changes</span>{/if}
      </div>
    </section>
  </div>
</div>
