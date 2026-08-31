<script lang="ts">
  import { untrack } from 'svelte';
  import { browser } from '$app/environment';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ModelCodeBadge from '$lib/components/ModelCodeBadge.svelte';
  import GradientTile from '$lib/components/GradientTile.svelte';
  import { runCard, runVersionLabel, type LaunchedRun } from './trainingFlow';

  let {
    launched,
    trigger,
    onExit,
  }: { launched: LaunchedRun[]; trigger: string; onExit: () => void } = $props();

  // Each run's checkpoint count is the epochs the user chose on Review; the recommended epoch is
  // near the end. Both drive the epoch grid, so they can't drift from a hardcoded count.
  const nck = (i: number) => Math.max(1, launched[i]!.params.epochs);
  const recEpoch = (i: number) => Math.max(1, Math.round(nck(i) * 0.8));

  interface Prog {
    step: number;
    total: number;
    epoch: number;
    done: boolean;
  }

  // Seeded once from the (stable) launched runs; the parent remounts this step via {#if}.
  let prog = $state<Prog[]>(
    untrack(() => launched.map((l) => ({ step: 0, total: Math.max(200, l.params.steps), epoch: 0, done: false }))),
  );
  let selEpoch = $state<number[]>(
    untrack(() => launched.map((l) => Math.max(1, Math.round(Math.max(1, l.params.epochs) * 0.8)))),
  );
  let published = $state(false);
  let note = $state('');

  const allDone = $derived(prog.every((p) => p.done));
  const name = $derived(trigger || 'your LoRA');
  const multi = $derived(launched.length > 1);

  function tick() {
    let running = false;
    prog.forEach((p, i) => {
      if (p.done) return;
      running = true;
      const n = nck(i);
      const inc = p.total / (34 + i * 6);
      p.step = Math.min(p.total, p.step + inc);
      p.epoch = Math.min(n, Math.floor((p.step / p.total) * n));
      if (p.step >= p.total) {
        p.step = p.total;
        p.epoch = n;
        p.done = true;
      }
    });
    if (!running && timer) clearInterval(timer);
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  $effect(() => {
    const reduce = browser && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    timer = setInterval(tick, reduce ? 40 : 150);
    return () => clearInterval(timer);
  });

  function skip() {
    if (timer) clearInterval(timer);
    prog = prog.map((p, i) => ({ ...p, step: p.total, epoch: nck(i), done: true }));
  }
  function pct(p: Prog) {
    return Math.min(100, Math.round((p.step / p.total) * 100));
  }
  function ready(i: number, e: number) {
    return prog[i]!.done || e <= prog[i]!.epoch;
  }
</script>

{#if published}
  <div class="py-8 text-center">
    <div class="text-4xl">🎉</div>
    <h1 class="mt-2 text-2xl font-semibold text-white">Published!</h1>
    <p class="mx-auto mt-1 max-w-md text-sm text-dark-2">
      Your LoRA is live{multi ? ` with ${launched.length} versions` : ''} — the first moment a public
      <strong class="text-dark-0">Model</strong> was created.
    </p>
    <div class="mx-auto mt-5 max-w-md overflow-hidden rounded-md border border-dark-4 bg-dark-6 text-left">
      {#each launched as l, i (l.run.id)}
        {@const card = runCard(l.run)}
        <div class="flex items-center gap-3 border-b border-dark-4 p-3 last:border-b-0">
          <GradientTile index={card.code.length + selEpoch[i]! + i * 2} class="aspect-auto h-12 w-12 shrink-0" />
          <div>
            <div class="font-bold text-dark-0">{name}{multi ? ` · Run ${i + 1}` : ''}</div>
            <div class="font-mono text-xs text-dark-2">{card.name} {runVersionLabel(l.run)} · Epoch {selEpoch[i]}</div>
          </div>
          <span class="ml-auto font-mono text-xs text-dark-2">v{i + 1}</span>
        </div>
      {/each}
    </div>
    <div class="mt-6 flex justify-center gap-3">
      <Button variant="outline" onclick={onExit}>← My trainings</Button>
      <Button onclick={() => (note = 'Would open the public model page on civitai.com.')}>View model page →</Button>
    </div>
    {#if note}<p class="mt-3 font-mono text-xs text-dark-2">{note}</p>{/if}
  </div>
{:else}
  <div class="flex flex-col gap-5">
    <div class="flex flex-wrap items-center gap-3">
      {#if allDone}
        <div class="flex items-center gap-2 rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-400">
          ✅ Training complete. Your weights are saved and ready — nothing is published yet.
        </div>
      {:else}
        <span class="inline-flex items-center gap-2 rounded bg-primary/15 px-2.5 py-1 font-mono text-[11px] font-semibold text-primary">
          <span class="h-2 w-2 rounded-full bg-emerald-400"></span> Live from orchestrator
        </span>
        <h1 class="m-0 text-2xl font-semibold text-white">Training <span class="text-[#f59f00]">{name}</span></h1>
        <Button variant="outline" size="sm" class="ml-auto" onclick={skip}>⏩ Skip simulation</Button>
      {/if}
    </div>

    {#each launched as l, i (l.run.id)}
      {@const card = runCard(l.run)}
      {@const p = prog[i]!}
      <div class="rounded-md border border-dark-4 bg-dark-6 p-4">
        <div class="mb-1 flex flex-wrap items-center gap-2">
          <ModelCodeBadge code={card.code} size="xs" />
          <h2 class="m-0 text-base font-semibold text-white">{multi ? `Run ${i + 1} · ` : ''}{card.name} {runVersionLabel(l.run)}</h2>
          {#if p.done}
            <span class="rounded bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-emerald-400">✓ complete</span>
          {:else}
            <span class="rounded bg-primary/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-primary">
              {p.step === 0 ? 'queued · downloading' : 'training'}
            </span>
          {/if}
        </div>

        {#if !p.done}
          <div class="py-2">
            <div class="relative h-2 overflow-hidden rounded-full bg-dark-7">
              <div class="h-full bg-[#f59f00]" style={`width:${pct(p)}%`}></div>
              {#each Array(nck(i) - 1) as _, k (k)}
                <span
                  class="absolute top-[-3px] h-3.5 w-0.5 {k + 1 <= p.epoch ? 'bg-emerald-400' : 'bg-dark-3'}"
                  style={`left:${((k + 1) / nck(i)) * 100}%`}
                ></span>
              {/each}
            </div>
            <div class="mt-2 flex flex-wrap gap-4 font-mono text-xs text-dark-2">
              <span>step <b class="text-dark-0">{Math.round(p.step).toLocaleString()} / {p.total.toLocaleString()}</b></span>
              <span>checkpoint <b class="text-dark-0">{p.epoch} / {nck(i)}</b></span>
              {#if p.step === 0}<span>queue <b class="text-dark-0">#2</b> · downloading model</span>{/if}
            </div>
          </div>
        {/if}

        <div class="mt-2 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
          {#each Array(nck(i)) as _, e0 (e0)}
            {@const e = e0 + 1}
            {#if ready(i, e)}
              <button
                type="button"
                onclick={() => p.done && (selEpoch[i] = e)}
                class="rounded-md border p-2.5 text-left transition
                  {selEpoch[i] === e && p.done ? 'border-primary ring-2 ring-primary/40' : 'border-dark-4 bg-dark-7'}"
              >
                <div class="mb-2 flex items-center justify-between">
                  <span class="text-sm font-bold text-dark-0">Epoch {e} {#if e === recEpoch(i) && p.done}<span class="text-[#f59f00]">★</span>{/if}</span>
                  <span class="font-mono text-[10px] text-dark-2">{p.done ? 'ready' : '✓'}</span>
                </div>
                <div class="grid grid-cols-2 gap-1.5">
                  {#each Array(4) as _, k (k)}
                    <GradientTile index={card.code.length + e + k + i * 2} />
                  {/each}
                </div>
              </button>
            {:else}
              <div class="rounded-md border border-dark-4 bg-dark-7 p-2.5 opacity-70">
                <div class="mb-2 flex items-center justify-between">
                  <span class="text-sm font-bold text-dark-0">Epoch {e}</span>
                  <span class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-dark-4 border-t-[#f59f00]"></span>
                </div>
                <div class="grid grid-cols-2 gap-1.5">
                  {#each Array(4) as _, k (k)}<div class="aspect-square rounded-md bg-dark-6"></div>{/each}
                </div>
              </div>
            {/if}
          {/each}
        </div>
      </div>
    {/each}

    {#if allDone}
      <div>
        <h2 class="m-0 text-xl font-semibold text-white">What next?</h2>
        <p class="mt-1 text-sm text-dark-2">
          Training and publishing are separate.
          {multi ? 'Publishing bundles your runs as versions of one model.' : 'Only “Publish” creates a public model page.'}
        </p>
        <div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <button type="button" onclick={() => (published = true)} class="rounded-md border border-primary bg-primary/10 p-4 text-left transition hover:-translate-y-0.5">
            <div class="text-lg">🚀</div>
            <div class="mt-1.5 text-sm font-bold text-dark-0">{multi ? `Publish ${launched.length} versions` : 'Publish'}</div>
            <div class="mt-0.5 text-[11px] text-dark-2">A public model page others can use.</div>
          </button>
          <button type="button" onclick={() => (note = 'Opens the generator with your selected epoch preloaded (via the orchestrator file / AIR).')} class="rounded-md border border-dark-4 bg-dark-6 p-4 text-left transition hover:-translate-y-0.5">
            <div class="text-lg">🎨</div>
            <div class="mt-1.5 text-sm font-bold text-dark-0">Generate</div>
            <div class="mt-0.5 text-[11px] text-dark-2">Try your LoRA in the generator now.</div>
          </button>
          <button type="button" onclick={() => (note = 'Downloads this epoch, or all as a bundle. Stays private — no model page.')} class="rounded-md border border-dark-4 bg-dark-6 p-4 text-left transition hover:-translate-y-0.5">
            <div class="text-lg">💾</div>
            <div class="mt-1.5 text-sm font-bold text-dark-0">Save / Download</div>
            <div class="mt-0.5 text-[11px] text-dark-2">One epoch, or download all.</div>
          </button>
          <button type="button" onclick={() => (note = 'Adds more checkpoints on the same data (a modal in a later slice).')} class="rounded-md border border-dark-4 bg-dark-6 p-4 text-left transition hover:-translate-y-0.5">
            <div class="text-lg">➕</div>
            <div class="mt-1.5 text-sm font-bold text-dark-0">Train further</div>
            <div class="mt-0.5 text-[11px] text-dark-2">More checkpoints on this data.</div>
          </button>
          <button type="button" onclick={onExit} class="rounded-md border border-dark-4 bg-dark-6 p-4 text-left transition hover:-translate-y-0.5">
            <div class="text-lg">🔀</div>
            <div class="mt-1.5 text-sm font-bold text-dark-0">Remix</div>
            <div class="mt-0.5 text-[11px] text-dark-2">Same settings, start fresh.</div>
          </button>
        </div>
        {#if note}<p class="mt-3 font-mono text-xs text-dark-2">{note}</p>{/if}
        <p class="mt-4 text-center font-mono text-[11px] text-dark-2">
          Your trained weights already exist independently of any model page.
        </p>
      </div>
    {/if}
  </div>
{/if}
