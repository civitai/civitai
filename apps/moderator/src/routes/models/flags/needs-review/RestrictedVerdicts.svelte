<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { SvelteSet } from 'svelte/reactivity';
  import ComFaceCard from '$lib/components/ComFaceCard.svelte';
  import { leadComCoverBlurred } from '$lib/com-face';
  import { ConfirmButton } from '@civitai/ui/components/confirm/index.js';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import { LINK_CLASS, shortAge } from '$lib/format';
  import {
    LIFTED_NOTE,
    type Restriction,
    type RestrictedVerdictRow,
  } from '$lib/minor-flags/restricted-verdicts';

  let {
    rows,
    total,
    civitaiUrl,
  }: { rows: RestrictedVerdictRow[]; total: number; civitaiUrl: string } = $props();

  const RESTRICTION_LABEL: Record<Restriction, string> = {
    minor: 'minor',
    poi: 'real person',
    sfwOnly: 'SFW only',
  };
  const DISMISS_REASONS = [
    'Escalated in Auto-flagged',
    'Escalated to CSAM tools',
    'Flags changed by hand',
  ];

  let open = $state<number | null>(null);
  // Leads whose hidden .com cover the moderator revealed, one row at a time.
  const revealed = new SvelteSet<number>();
  let reasons = $state<Record<number, string>>({});
  let errors = $state<Record<number, string>>({});
  let pending = $state<number | null>(null);

  const canRateNsfw = (row: RestrictedVerdictRow) => !row.minor && !row.poi && !row.isPrivate;
  // NSFW with SFW-only is a pair the owner form refuses, so the lead may not close on it.
  const unsaveable = (row: RestrictedVerdictRow) => row.nsfw && row.sfwOnly;
  const needsReason = (row: RestrictedVerdictRow) =>
    row.restriction === 'minor' && !reasons[row.modelId]?.trim();

  const submit =
    (modelId: number): SubmitFunction =>
    () => {
      pending = modelId;
      return async ({ result, update }) => {
        pending = null;
        if (result.type === 'failure')
          errors[modelId] = String(result.data?.error ?? 'The ruling failed.');
        else {
          delete errors[modelId];
          open = null;
          await invalidateAll();
        }
        await update({ reset: false, invalidateAll: false });
      };
    };
</script>

{#if rows.length}
  <section class="rounded-md border border-red-6/40 bg-dark-6 p-3" aria-label="Scan rated NSFW">
    <h2 class="m-0 text-sm font-semibold">
      Scan rated NSFW on a restricted model
      <span class="text-dark-2"
        >({total > rows.length ? `${rows.length} of ${total} shown` : rows.length})</span
      >
    </h2>
    <p class="m-0 mt-1 text-xs text-dark-2">
      The owner marked these minor, a real person or SFW-only. Minor and real-person models keep their
      rating until you rule or the owner unticks the flag; SFW-only models were rated NSFW, and Keep
      restores SFW-only. Minor first.
    </p>
    <ul class="m-0 mt-2 flex list-none flex-col gap-2 p-0">
      {#each rows as row (row.modelId)}
        <li class="rounded border border-dark-4 p-2 text-sm">
          <div class="flex flex-wrap items-center gap-1.5">
            <a
              class={LINK_CLASS}
              href={`${civitaiUrl}/models/${row.modelId}`}
              target="_blank"
              rel="noreferrer">{row.modelName}</a
            >
            <MetaChip tone={row.restriction === 'minor' ? 'red' : 'neutral'}>
              {RESTRICTION_LABEL[row.restriction]}
            </MetaChip>
            {#if !row.comFace}<MetaChip>No .com face</MetaChip>{/if}
            {#if row.isPrivate && !row.liftedBy}
              <MetaChip>private: applies when published</MetaChip>
            {/if}
            {#if row.unticked}
              <MetaChip tone="amber">
                held as {RESTRICTION_LABEL[row.restriction]}; {LIFTED_NOTE[row.liftedBy ?? 'owner']}
              </MetaChip>
            {/if}
            {#if row.autoApplied}
              <MetaChip tone="amber">
                {row.unticked ? 'rated NSFW when unticked' : 'rated NSFW, SFW-only cleared'}
              </MetaChip>
            {:else if row.systemLocked}<MetaChip>locked NSFW by an earlier scan</MetaChip>{/if}
            <span class="text-xs text-dark-2">
              by {row.username ?? `user #${row.userId}`}
              {#if row.heldAt}· held {shortAge(row.heldAt)}{/if}
              {#if row.source}· {row.source}{/if}
            </span>
            <Button
              size="sm"
              variant="ghost"
              class="ml-auto"
              onclick={() => (open = open === row.modelId ? null : row.modelId)}
            >
              {open === row.modelId ? 'Close' : 'Rule'}
            </Button>
          </div>
          {#if row.comFace}
            <div class="mt-2">
              <ComFaceCard
                face={row.comFace}
                bare
                blurred={leadComCoverBlurred(row, revealed)}
                onReveal={() => revealed.add(row.modelId)}
              />
            </div>
          {/if}
          {#if open === row.modelId}
            <div class="mt-2 flex flex-col gap-2">
              <dl class="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
                {#if row.scanLevel !== null}
                  <dt class="text-dark-2">Scan level</dt>
                  <dd class="m-0">{row.scanLevel}</dd>
                {/if}
                {#if row.scanLabels.length}
                  <dt class="text-dark-2">Scan labels</dt>
                  <dd class="m-0">{row.scanLabels.join(', ')}</dd>
                {/if}
                {#if row.scanReason}
                  <dt class="text-dark-2">Scan reason</dt>
                  <dd class="m-0 whitespace-pre-wrap">{row.scanReason}</dd>
                {/if}
                {#if row.forensics?.labels?.length}
                  <dt class="text-dark-2">XGuard labels</dt>
                  <dd class="m-0">
                    {row.forensics.labels.map((l) => `${l.label} ${l.score.toFixed(2)}`).join(', ')}
                  </dd>
                {/if}
                {#if row.forensics?.matchedTerms?.length}
                  <dt class="text-dark-2">Matched</dt>
                  <dd class="m-0">{row.forensics.matchedTerms.join(', ')}</dd>
                {/if}
              </dl>
              <form method="POST" action="?/ruleRestrictedVerdict" use:enhance={submit(row.modelId)}>
                <input type="hidden" name="modelId" value={row.modelId} />
                <label class="flex flex-col gap-1 text-xs">
                  <span class="text-dark-2">
                    Reason {row.restriction === 'minor'
                      ? '(required to dismiss or rate NSFW a minor lead)'
                      : ''}
                  </span>
                  <select
                    class="rounded border border-dark-4 bg-dark-7 p-1"
                    onchange={(e) => (reasons[row.modelId] = e.currentTarget.value)}
                  >
                    <option value="">Pick or type below…</option>
                    {#each DISMISS_REASONS as r (r)}<option value={r}>{r}</option>{/each}
                  </select>
                  <textarea
                    name="reason"
                    rows="2"
                    class="rounded border border-dark-4 bg-dark-7 p-1"
                    bind:value={() => reasons[row.modelId] ?? '', (v) => (reasons[row.modelId] = v)}
                  ></textarea>
                </label>
                <div class="mt-2 flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    name="ruling"
                    value="keep"
                    disabled={pending === row.modelId}>Keep owner's rating</Button
                  >
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    name="ruling"
                    value="dismiss"
                    disabled={pending === row.modelId || needsReason(row) || unsaveable(row)}
                    title={unsaveable(row)
                      ? "Keep or Rate NSFW: the model can't be saved as it is."
                      : undefined}>Dismiss</Button
                  >
                  {#if canRateNsfw(row)}
                    <ConfirmButton
                      label="Rate NSFW"
                      title="Rate this model NSFW?"
                      description="This unsets SFW-only, marks the model NSFW and locks the rating as yours."
                      disabled={pending === row.modelId || needsReason(row)}
                      onconfirm={() => {
                        const form = document.getElementById(
                          `restricted-rate-${row.modelId}`
                        ) as HTMLFormElement | null;
                        form?.requestSubmit();
                      }}
                    />
                  {/if}
                </div>
              </form>
              {#if canRateNsfw(row)}
                <form
                  id={`restricted-rate-${row.modelId}`}
                  method="POST"
                  action="?/ruleRestrictedVerdict"
                  class="hidden"
                  use:enhance={submit(row.modelId)}
                >
                  <input type="hidden" name="modelId" value={row.modelId} />
                  <input type="hidden" name="ruling" value="rateNsfw" />
                  <input type="hidden" name="reason" value={reasons[row.modelId] ?? ''} />
                </form>
              {/if}
              {#if errors[row.modelId]}
                <p class="m-0 text-xs text-red-5" role="alert">{errors[row.modelId]}</p>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}
