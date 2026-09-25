<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { dateTime } from '$lib/format';
  import { ABUSE_VERDICTS, type AbuseVerdict } from '$lib/abuse-verdicts';
  import {
    VERDICT_CLASS,
    VERDICT_HINT,
    VERDICT_LABEL,
    verdictAttribution,
  } from './finding-presentation';

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
   * A raw `<button>` rather than `@civitai/ui`'s `Button`, with the focus treatment taken by hand.
   *
   * The primitive's own `focus-visible` ring is the one thing worth having here — `global.css` sets
   * `outline-ring/50` on `*` with no width, so an unaided button gets the UA default recoloured, and
   * this is a keyboard-driven queue. The rest of the primitive fights this control: `outline`
   * carries `dark:bg-input/30` and `dark:hover:bg-input/50`, which `cn()` does NOT displace with an
   * unprefixed `bg-*`, so a filled verdict would be overpainted in the only mode this app runs in;
   * and `size: default` pins `h-8`, against a full-width control sized by its own padding. The five
   * nearest analogues in this app (`images/ratings`, `images/tags`, `comics-review`, …) are all raw
   * buttons of exactly this shape.
   */
  const FOCUS_CLASS =
    'outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3';
</script>

<!-- 🔴 A FULL-WIDTH AREA BENEATH THE FINDING, NEVER A COLUMN BESIDE IT. As a fifth table cell this
     control sat wherever the four columns to its left had pushed it: on a cluster whose member list
     widened the account column, the buttons left the viewport entirely, so the larger the
     coordinated group the further off-screen the control that rules it. Nothing to its left can
     move it here. -->
<!-- 🔴 "NOT YET RULED" IS A CLAIM ABOUT A BACKLOG, so nothing here renders where there cannot be one
     — the rule ABOVE the block included, or every card would carry an empty divider. Without the
     verdict columns every finding reads back as `verdict: null`, the same value as genuinely
     unruled, so an ungated line would tell a moderator once per card that nobody has got to these
     yet on a board where nobody ever can. That is the null-vs-zero conflation the list page's own
     `ruledLabel` refuses to make, and the page banner above already explains the state.
     `shown !== null` is still honoured in that mode: it cannot happen, and a ruling that somehow
     exists must not be hidden. -->
{#if canRule || shown !== null}
  <div class="border-dark-4 mt-4 border-t pt-4">
    <div class="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <!-- 🔴 A SEPARATE JUDGEMENT FROM THE DETECTOR'S "acted", and the label says whose it is. The
           two are independent: the common finding is one the detector left alone and a moderator
           rules correct. -->
      <span class="text-dark-2 text-sm">Your verdict</span>
      {#if shown === null}
        <span class="text-dark-2 text-sm">— not yet ruled</span>
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
          <!-- `basis-56` + `grow` + `max-w-xs`: three across on a wide card, wrapping to one column
               rather than overflowing as the content column narrows. -->
          <form method="POST" action="?/verdict" use:enhance={submit(v)} class="max-w-xs grow basis-56">
            <!-- The LEAD's id. The server reads the group key off this row and rules every member
                 sharing it IN THIS RUN — the run bound lives there, not here, because everything in
                 this form is attacker-supplied. -->
            <input type="hidden" name="findingId" value={findingId} />
            <input type="hidden" name="verdict" value={v} />
            <button
              type="submit"
              aria-pressed={shown === v}
              aria-describedby="verdict-hint-{findingId}-{v}"
              class="w-full rounded border px-3 py-2 text-sm font-semibold transition {FOCUS_CLASS} {shown ===
              v
                ? VERDICT_CLASS[v].chosen
                : VERDICT_CLASS[v].idle}">{VERDICT_LABEL[v]}</button
            >
            <!-- Outside the button rather than inside it, so the hint keeps one contrast ratio
                 whether or not its button is filled — and tied back to it by id, so a screen reader
                 reaches the expansion the sighted reader gets for free. The finding id is in the id
                 because every card on the page offers the same three verdicts. -->
            <p id="verdict-hint-{findingId}-{v}" class="text-dark-2 mt-1 text-xs">
              {VERDICT_HINT[v]}
            </p>
          </form>
        {/each}
      </div>
    {/if}
  </div>
{/if}
