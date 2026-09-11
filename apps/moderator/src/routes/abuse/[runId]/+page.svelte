<script lang="ts">
  import { enhance } from '$app/forms';
  import { SvelteMap } from 'svelte/reactivity';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { optimisticEnhancer } from '$lib/form-action';
  import { dateTime, num, LINK_CLASS } from '$lib/format';
  import { ABUSE_VERDICTS, type AbuseVerdict } from '$lib/abuse-verdicts';
  import { groupFindings, storedVerdict } from '$lib/abuse-decisions';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  type Finding = PageData['findings'][number];

  const counters = $derived(Object.entries(data.run.counters).sort(([a], [b]) => a.localeCompare(b)));

  // Two digits, not a percentage. These are the producer's own 0..1 scores and are NOT comparable
  // across detectors — rendering "94%" invites exactly the cross-detector ranking that would be
  // meaningless, and a bare decimal reads as the raw number it is.
  const confidence = (v: number) => v.toFixed(2);

  const VERDICT_LABEL: Record<AbuseVerdict, string> = {
    tp: 'Correct',
    fp: 'False positive',
    skip: 'Skip',
  };
  // Spelled out beside the buttons, because "TP" is jargon for the person who wrote the detector and
  // nothing at all for the moderator being asked to rule.
  const VERDICT_HINT: Record<AbuseVerdict, string> = {
    tp: 'The detector was right about this account.',
    fp: 'The detector was wrong — this account is fine.',
    skip: 'Looked at it; not calling it either way.',
  };
  const VERDICT_CLASS: Record<AbuseVerdict, string> = {
    tp: 'border-rose-500/40 text-rose-400 hover:bg-rose-500/10',
    fp: 'border-teal-600/40 text-teal-400 hover:bg-teal-500/10',
    skip: 'border-muted-foreground/40 text-muted-foreground hover:bg-muted/40',
  };

  /**
   * 🔴 ONE DECISION PER CLUSTER, NOT PER ROW. A coordinated ring arrives as N findings the producer
   * has already said are one actor; rendering N rows asks a moderator to make the same judgement N
   * times and — because they will stop partway — leaves the run half-ruled with no way to tell a
   * deliberate partial ruling from an abandoned one.
   *
   * The rule itself lives in `$lib/abuse-decisions.ts` and is tested there: this app has no
   * component render harness, so a `$derived` written here would be logic nothing can assert.
   */
  type Decision = ReturnType<typeof groupFindings<Finding>>[number];

  const decisions = $derived(groupFindings(data.findings));

  const ruledBy = (d: Decision) => d.lead.verdictBy;
  const ruledAt = (d: Decision) => d.lead.verdictAt;

  // decision id → the verdict this session just submitted, shown until the reload lands.
  const pending = new SvelteMap<string, AbuseVerdict>();
  $effect(() => {
    data.findings;
    pending.clear();
  });

  const submit = (d: Decision, verdict: AbuseVerdict) =>
    optimisticEnhancer(
      () => {
        pending.set(d.id, verdict);
        return () => pending.delete(d.id);
      },
      // Re-runs the load on success, so the rendered verdict and the run's "still to review" count
      // come from the database rather than from what this page hoped would happen.
      { reload: true }
    );

  /** A few members, named. Not all of them: the point of collapsing is that the list is long. */
  const EXAMPLES = 4;
</script>

<header class="page-header">
  <h1>{data.run.detector}</h1>
  <p class="text-dark-2">
    Ran {dateTime(data.run.startedAt)} → {dateTime(data.run.finishedAt)}
    · reported {dateTime(data.run.receivedAt)}
  </p>
</header>

<p class="mb-4"><a class={LINK_CLASS} href="/abuse">← All runs</a></p>

{#if data.run.summary}
  <p class="mb-4">{data.run.summary}</p>
{/if}

{#if counters.length > 0}
  <dl class="mb-6 flex flex-wrap gap-x-6 gap-y-1">
    {#each counters as [key, value] (key)}
      <div>
        <dt class="text-dark-2 text-sm">{key}</dt>
        <dd>{num(value)}</dd>
      </div>
    {/each}
  </dl>
{/if}

{#if data.verdicts === null}
  <!-- 🔴 READ-ONLY, AND IT SAYS SO. `null` is not "nothing ruled yet" — it is "this deployment
       cannot record a ruling", because the verdict columns have never been applied here. The
       controls are withheld rather than shown-and-broken: a button that always errors teaches a
       moderator the board is broken, when the board is fine and a one-line DDL has not been run. -->
  <p class="text-dark-2 mb-4">
    Verdicts cannot be recorded here yet — <code>abuse_detection_finding</code> has no verdict
    columns. They are applied by hand: run
    <code>apps/moderator/abuse-detection/schema.sql</code> against
    <code>MODERATOR_DATABASE_URL</code> as the application role. Everything below still reads.
  </p>
{:else}
  <p class="mb-4">
    <!-- The run's WHOLE population, not the page's. `getAbuseFindings` caps and reports it
         separately; a count derived from the rendered rows would present that cap as a total. -->
    {num(data.verdicts.unruled)} of {num(data.verdicts.ruled + data.verdicts.unruled)} findings still
    to review.
  </p>
{/if}

{#if form?.error}
  <p class="mb-4 text-rose-400">{form.error}</p>
{/if}

{#if data.truncated}
  <!-- Never truncate silently: the list page shows this run's true total, so a quiet cap makes the
       two screens disagree about the same run and hides exactly the rows the sort pushed down. -->
  <p class="text-dark-2 mb-2">
    Showing the first {num(data.findings.length)} of {num(data.run.findingCount)} findings.
  </p>
{/if}

{#if decisions.length === 0}
  <!-- A run with no findings is a real, healthy result and must not read as a broken page. -->
  <p class="text-dark-2">This run reported no findings.</p>
{:else}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>User</TableHead>
        <!-- Both columns are the PRODUCER's self-report, never cross-checked against the action log.
             Headed as reported so the board cannot be read as independent confirmation that
             something was done — it is an input to a human decision, not evidence. -->
        <TableHead>Confidence (reported)</TableHead>
        <TableHead>Acted (reported)</TableHead>
        <TableHead>Reason</TableHead>
        <!-- 🔴 A SEPARATE COLUMN FROM "Acted", and the heading says whose opinion it is. The two are
             independent: the common row is not-acted-on and ruled correct. -->
        <TableHead>Your verdict</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each decisions as d (d.id)}
        {@const stored = storedVerdict(d)}
        {@const shown = pending.get(d.id) ?? stored}
        <TableRow>
          <TableCell>
            <!-- `?q=`, not `?userId=` — an unknown param is dropped, landing the moderator on an
                 empty search.
                 🔴 And the SECTION is named rather than left to the bare route's redirect, which
                 lands on Basic. Following this link used to arrive at a page with ~20 panels and
                 nothing about abuse detection; mod-activity is where AbuseFindingsPanel renders, so
                 the finding a moderator clicked is on the page they land on. -->
            <a class={LINK_CLASS} href="/retool/user-lookup/mod-activity?q={d.lead.userId}"
              >{d.lead.userId}</a
            >
            {#if d.members.length > 1}
              <!-- The SIZE first, because it is what changes the decision: ruling one account and
                   ruling eleven are different acts. The examples follow so the sentence is
                   checkable rather than a number to be taken on trust. -->
              <div class="text-dark-2 mt-1 text-xs">
                {num(d.members.length)} accounts, ruled together —
                {#each d.members.slice(1, EXAMPLES + 1) as m, i (m.id)}{i > 0 ? ', ' : ''}<a
                    class={LINK_CLASS}
                    href="/retool/user-lookup/mod-activity?q={m.userId}">{m.userId}</a
                  >{/each}{#if d.members.length > EXAMPLES + 1}
                  and {num(d.members.length - EXAMPLES - 1)} more{/if}
              </div>
            {/if}
          </TableCell>
          <TableCell>{confidence(d.lead.confidence)}</TableCell>
          <!-- "No" is the common and important case: detected, scored, deliberately left alone. It is
               spelled out rather than shown as a blank, which would read as missing data. -->
          <TableCell>{d.lead.actioned ? d.lead.action : 'No'}</TableCell>
          <TableCell class="max-w-2xl">{d.lead.reason}</TableCell>
          <TableCell>
            {#if shown !== null}
              <div class="text-xs font-semibold">
                {shown === 'mixed' ? 'Mixed — members ruled separately' : VERDICT_LABEL[shown]}
              </div>
              {#if ruledBy(d) && stored !== null && stored !== 'mixed'}
                <!-- The CURRENT ruling and who stands behind it. A re-ruling overwrites both, so
                     this never shows the person who was later corrected.
                     🔴 WITHHELD ON A MIXED CLUSTER. This reads the LEAD's ruler, and on a cluster
                     whose members disagree that is one person's name printed beside a verdict the
                     others did not give — the board attributing a ruling nobody made. -->
                <div class="text-dark-2 text-xs">
                  {ruledBy(d)}{#if ruledAt(d)} · {dateTime(ruledAt(d) as Date)}{/if}
                </div>
              {/if}
            {/if}
            {#if data.verdicts !== null}
              <div class="mt-1 flex flex-wrap gap-1.5">
                {#each ABUSE_VERDICTS as v (v)}
                  <form method="POST" action="?/verdict" use:enhance={submit(d, v)}>
                    <!-- The LEAD's id. The server reads the group key off this row and rules every
                         member sharing it IN THIS RUN — the run bound lives there, not here, because
                         everything in this form is attacker-supplied. -->
                    <input type="hidden" name="findingId" value={d.lead.id} />
                    <input type="hidden" name="verdict" value={v} />
                    <button
                      type="submit"
                      title={VERDICT_HINT[v]}
                      aria-pressed={shown === v}
                      class="rounded border px-2 py-1 text-xs font-semibold transition {VERDICT_CLASS[
                        v
                      ]} {shown === v ? 'bg-muted/60' : ''}">{VERDICT_LABEL[v]}</button
                    >
                  </form>
                {/each}
              </div>
            {/if}
          </TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>
{/if}
