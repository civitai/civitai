<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const loop = [
    { step: 'Sample', what: 'Pull live prompts, stratified across a label\'s score bands.', where: '/xguard/batches' },
    { step: 'Rate', what: 'A model gives every sample a first-pass verdict with the exact spans it judged on.', where: null },
    { step: 'Review', what: 'A human confirms or overturns each rating. This, and only this, is ground truth.', where: '/xguard' },
    { step: 'Evaluate', what: 'Score a policy version against that ground truth and read what it got wrong.', where: '/xguard/runs' },
    { step: 'Edit', what: 'Rewrite the policy prose against the false positives and negatives, then evaluate again.', where: '/xguard/labels' },
  ];
</script>

<header class="page-header">
  <h1>XGuard Lab — operator guide</h1>
  <p>How the tuning loop works, and the API an agent drives it with.</p>
</header>

<div class="flex flex-col gap-6">
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-1 text-base font-semibold text-white">The loop</h2>
    <p class="mb-4 text-sm text-dark-2">
      The point is the loop, not any one label. Everything here exists to turn a policy written in prose
      into a number you can compare against last week's number.
    </p>
    <ol class="flex flex-col gap-2">
      {#each loop as s, i (s.step)}
        <li class="flex gap-3 rounded-lg bg-dark-7 px-3 py-2.5">
          <span class="font-mono text-sm text-dark-3">{i + 1}</span>
          <div class="flex-1">
            <div class="text-sm font-semibold text-dark-0">{s.step}</div>
            <div class="text-sm text-dark-2">{s.what}</div>
          </div>
          {#if s.where}
            <a href={s.where} class="self-center text-xs text-blue-4 hover:text-blue-3">{s.where}</a>
          {/if}
        </li>
      {/each}
    </ol>
  </section>

  <section class="rounded-xl border border-red-8/40 bg-red-8/10 p-5">
    <h2 class="mb-1 text-base font-semibold text-red-2">Agents cannot record judgements</h2>
    <p class="text-sm text-dark-1">
      An API key can read everything, sample, rate, edit policies and run evaluations — the whole tuning
      loop. It cannot write <code class="font-mono">human_judgement</code>. That table is what a
      <em>person</em> confirmed, and if a model could write to it the ground truth would become a model
      agreeing with itself, in rows indistinguishable from real ones. Reviewing is done in the browser,
      signed in, and every row carries the reviewer's user id.
    </p>
  </section>

  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-1 text-base font-semibold text-white">Getting access</h2>
    <ol class="ml-4 list-decimal text-sm text-dark-2">
      <li class="mb-1">
        Your Civitai account needs the <code class="font-mono text-dark-1">moderator:senior</code> role.
        Ask a moderator admin — the same role opens these pages in a browser.
      </li>
      <li class="mb-1">
        Create a personal API key in your Civitai account settings. OAuth application tokens are refused
        here on purpose: consenting to an app must not hand that app moderator tooling.
      </li>
      <li>
        Send it as <code class="font-mono text-dark-1">Authorization: Bearer &lt;key&gt;</code>. The key
        acts as you, with your roles — so losing the role ends the agent's access too.
      </li>
    </ol>
    <pre class="mt-3 overflow-x-auto rounded-lg bg-dark-8 p-3 font-mono text-xs text-dark-1">curl -H "Authorization: Bearer $CIVITAI_API_KEY" \
  https://moderator.civitai.com/api/xguard/me</pre>
  </section>

  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-1 text-base font-semibold text-white">Two things that confuse everyone</h2>
    <div class="flex flex-col gap-3">
      <div class="rounded-lg bg-dark-7 px-3 py-2.5">
        <div class="text-sm font-semibold text-dark-0">Precision and recall show n/a, not 0.000</div>
        <p class="text-sm text-dark-2">
          With no confirmed positives in the ground truth, recall has no value at all. Reporting
          <code class="font-mono">0.000</code> would read as "the policy got everything wrong" when it
          means "there was nothing to measure". Fix it by confirming some positives, not by tuning.
        </p>
      </div>
      <div class="rounded-lg bg-dark-7 px-3 py-2.5">
        <div class="text-sm font-semibold text-dark-0">Thresholds do not transfer between scanners</div>
        <p class="text-sm text-dark-2">
          A threshold tuned against XGuard means nothing to another scanner — one candidate's scores for
          the same label topped out at 0.44 across a whole batch, so its own default of 0.5 would have
          fired on nothing. Always read a threshold together with the scanner it belongs to.
        </p>
      </div>
    </div>
  </section>

  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <div class="mb-1 flex items-baseline gap-3">
      <h2 class="text-base font-semibold text-white">Endpoints</h2>
      <span class="text-xs text-dark-3">generated from the routes — this list cannot drift</span>
    </div>
    <div class="mt-4 flex flex-col gap-3">
      {#each data.endpoints as e (e.path)}
        <article class="rounded-lg bg-dark-7 px-3 py-2.5">
          <div class="flex flex-wrap items-baseline gap-2">
            {#each e.methods as m (m)}
              <span
                class="rounded px-1.5 py-0.5 font-mono text-xs {m === 'GET'
                  ? 'bg-blue-8/40 text-blue-3'
                  : 'bg-green-8/30 text-green-3'}">{m}</span>
            {/each}
            <code class="font-mono text-sm text-dark-0">{e.path}</code>
          </div>

          {#if e.doc}
            <p class="mt-1.5 text-sm text-dark-2">{e.doc.summary}</p>

            {#if e.doc.params?.length}
              <table class="mt-2 w-full text-left text-xs">
                <tbody>
                  {#each e.doc.params as p (p.name + p.type)}
                    <tr class="align-top">
                      <td class="whitespace-nowrap py-0.5 pr-3 font-mono text-dark-1">
                        {p.name}{p.required ? '*' : ''}
                      </td>
                      <td class="whitespace-nowrap py-0.5 pr-3 font-mono text-dark-3">{p.type}</td>
                      <td class="py-0.5 text-dark-2">{p.description}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}

            {#if e.doc.returns}
              <p class="mt-2 text-xs text-dark-3">
                <span class="text-dark-2">Returns:</span>
                {e.doc.returns}
              </p>
            {/if}

            {#if e.doc.notes?.length}
              <ul class="mt-2 ml-4 list-disc text-xs text-dark-2">
                {#each e.doc.notes as n (n)}
                  <li>{n}</li>
                {/each}
              </ul>
            {/if}
          {:else}
            <p class="mt-1.5 text-sm text-red-3">
              Undocumented — this route has no <code class="font-mono">_doc</code> export.
            </p>
          {/if}
        </article>
      {/each}
    </div>
  </section>
</div>
