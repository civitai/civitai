<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import { optimisticEnhancer } from '$lib/form-action';
  import { dateTime, num, LINK_CLASS } from '$lib/format';
  import type { AbuseVerdict } from '$lib/abuse-verdicts';
  import { groupFindings, storedVerdict } from '$lib/abuse-decisions';
  import FindingCard from './FindingCard.svelte';
  import RunCounters from './RunCounters.svelte';
  import { plural } from './finding-presentation';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  type Finding = PageData['findings'][number];

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
  <p class="mb-4 break-words whitespace-normal">{data.run.summary}</p>
{/if}

<RunCounters counters={data.run.counters} />

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
    {num(data.verdicts.unruled)} of {plural(
      data.verdicts.ruled + data.verdicts.unruled,
      'finding'
    )} still to review.
  </p>
{/if}

{#if form?.error}
  <p class="mb-4 text-rose-400">{form.error}</p>
{/if}

{#if data.truncated}
  <!-- Never truncate silently: the list page shows this run's true total, so a quiet cap makes the
       two screens disagree about the same run and hides exactly the rows the sort pushed down. -->
  <p class="text-dark-2 mb-2">
    Showing the first {num(data.findings.length)} of {plural(data.run.findingCount, 'finding')}.
  </p>
{/if}

{#if decisions.length === 0}
  <!-- A run with no findings is a real, healthy result and must not read as a broken page. -->
  <p class="text-dark-2">This run reported no findings.</p>
{:else}
  <div class="space-y-4">
    {#each decisions as d (d.id)}
      {@const stored = storedVerdict(d)}
      <FindingCard
        decision={d}
        {stored}
        shown={pending.get(d.id) ?? stored}
        viewerId={data.user?.id ?? null}
        canRule={data.verdicts !== null}
        submit={(verdict) => submit(d, verdict)}
      />
    {/each}
  </div>
{/if}
