<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { dateTime } from '$lib/format';
  import { ABUSE_VERDICTS, type AbuseVerdict } from '$lib/abuse-verdicts';
  import { VERDICT_HINT, VERDICT_LABEL, verdictAttribution } from './finding-presentation';

  let {
    findingId,
    shown,
    stored,
    verdictBy,
    verdictAt,
    viewerId,
    canRule,
    submit,
  }: {
    /** The LEAD finding's id. The server reads the group key off that row and rules the cluster. */
    findingId: number;
    /** What to render as chosen: this session's un-landed click, else what is stored. */
    shown: AbuseVerdict | 'mixed' | null;
    /** What the database holds, which is what the attribution belongs to. */
    stored: AbuseVerdict | 'mixed' | null;
    verdictBy: string | null;
    verdictAt: Date | null;
    viewerId: number | null;
    /** False on a deployment whose verdict columns are not applied — see the page's own notice. */
    canRule: boolean;
    submit: (verdict: AbuseVerdict) => SubmitFunction;
  } = $props();

  /**
   * 🔴 WITHHELD ON A MIXED CLUSTER. This reads the LEAD's ruler, and on a cluster whose members
   * disagree that is one person's name printed beside a verdict the others did not give — the board
   * attributing a ruling nobody made.
   */
  const attribution = $derived(
    stored === null || stored === 'mixed'
      ? null
      : verdictAttribution(verdictBy, verdictAt, viewerId, dateTime)
  );

  /**
   * 🔴 THE CHOSEN VERDICT IS FILLED, NOT TINTED. It used to be a transparent button carrying
   * `bg-muted/60`, which against this page's near-black panel is a lightness step of about 0.03 —
   * invisible in a column of three, so a moderator could not tell a ruled finding from an unruled
   * one without reading the line above it. `aria-pressed` carried the state correctly the whole
   * time; only the eye was unserved.
   */
  const VERDICT_CLASS: Record<AbuseVerdict, { idle: string; chosen: string }> = {
    tp: {
      idle: 'border-rose-500/40 text-rose-400 hover:bg-rose-500/10',
      chosen: 'border-rose-400 bg-rose-600 text-white',
    },
    fp: {
      idle: 'border-teal-600/40 text-teal-400 hover:bg-teal-500/10',
      chosen: 'border-teal-400 bg-teal-700 text-white',
    },
    skip: {
      idle: 'border-dark-3/60 text-dark-1 hover:bg-dark-4/60',
      chosen: 'border-dark-2 bg-dark-3 text-white',
    },
  };
</script>

<!-- 🔴 A FULL-WIDTH AREA BENEATH THE FINDING, NEVER A COLUMN BESIDE IT. As a fifth table cell this
     control sat wherever the four columns to its left had pushed it: on a cluster whose member list
     widened the account column, the buttons left the viewport entirely, so the larger the
     coordinated group the further off-screen the control that rules it. Nothing to its left can
     move it here. -->
<div class="border-dark-4 mt-4 border-t pt-4">
  <div class="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
    <!-- 🔴 A SEPARATE JUDGEMENT FROM THE DETECTOR'S "acted", and the label says whose it is. The two
         are independent: the common finding is one the detector left alone and a moderator rules
         correct. -->
    <span class="text-dark-2 text-sm">Your verdict</span>
    {#if shown === null}
      <span class="text-dark-2 text-sm">Not yet ruled.</span>
    {:else}
      <span class="text-sm font-semibold">
        {shown === 'mixed' ? 'Mixed — members ruled separately' : VERDICT_LABEL[shown]}
      </span>
      {#if attribution}
        <span class="text-dark-2 text-xs">{attribution}</span>
      {/if}
    {/if}
  </div>

  {#if canRule}
    <div class="flex flex-wrap gap-3">
      {#each ABUSE_VERDICTS as v (v)}
        <form method="POST" action="?/verdict" use:enhance={submit(v)} class="max-w-xs grow basis-56">
          <!-- The LEAD's id. The server reads the group key off this row and rules every member
               sharing it IN THIS RUN — the run bound lives there, not here, because everything in
               this form is attacker-supplied. -->
          <input type="hidden" name="findingId" value={findingId} />
          <input type="hidden" name="verdict" value={v} />
          <button
            type="submit"
            aria-pressed={shown === v}
            class="w-full rounded border px-3 py-2 text-sm font-semibold transition {shown === v
              ? VERDICT_CLASS[v].chosen
              : VERDICT_CLASS[v].idle}">{VERDICT_LABEL[v]}</button
          >
          <!-- Outside the button rather than inside it, so the hint keeps one contrast ratio whether
               or not its button is filled. -->
          <p class="text-dark-2 mt-1 text-xs">{VERDICT_HINT[v]}</p>
        </form>
      {/each}
    </div>
  {/if}
</div>
