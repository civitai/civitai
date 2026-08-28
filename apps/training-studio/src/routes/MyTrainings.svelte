<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';

  let { onNew, onOpen }: { onNew: () => void; onOpen: (name: string) => void } = $props();

  type RunState = 'ready' | 'training' | 'published' | 'failed';
  interface TrainingRow {
    name: string;
    base: string;
    code: string;
    state: RunState;
    sub: string;
    pct: number;
    progress: string;
  }

  // Sample data — wire to the user's training workflows (tagged, from the orchestrator) later.
  const rows: TrainingRow[] = [
    { name: 'my_character', base: 'Flux · Dev', code: 'FL', state: 'ready', sub: '12 images · character', pct: 0, progress: '' },
    { name: 'ink_wash_style', base: 'SDXL · Standard', code: 'XL', state: 'training', sub: '28 images · style', pct: 62, progress: 'step 5,120 / 8,400 · checkpoint 6/10' },
    { name: 'chibi_pack', base: 'SDXL · Pony', code: 'XL', state: 'published', sub: '40 images · 1.2k downloads', pct: 0, progress: '' },
    { name: 'retro_poster', base: 'SDXL · Illustrious', code: 'XL', state: 'failed', sub: 'refunded ⚡ 1,750', pct: 0, progress: '' },
  ];

  const status: Record<RunState, { label: string; cls: string }> = {
    ready: { label: '✓ ready', cls: 'text-emerald-400 bg-emerald-500/15' },
    training: { label: 'training', cls: 'text-primary bg-primary/15' },
    published: { label: 'published', cls: 'text-amber-400 bg-amber-500/15' },
    failed: { label: 'failed', cls: 'text-red-400 bg-red-500/15' },
  };
</script>

<section class="flex flex-col gap-5">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <h2 class="m-0 text-xl font-semibold text-white">My trainings</h2>
      <p class="mt-1 text-sm text-dark-2">
        Every run stays here — open one for live progress or results, train it further, or start
        something new.
      </p>
    </div>
    <Button onclick={onNew}>+ New training</Button>
  </div>

  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {#each rows as r (r.name)}
      <div class="overflow-hidden rounded-xl border border-dark-4 bg-dark-6">
        <div class="flex items-center gap-3 border-b border-dark-4 p-3.5">
          <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 font-mono text-[10px] font-extrabold text-primary">
            {r.code}
          </span>
          <div class="min-w-0">
            <div class="truncate text-sm font-bold text-dark-0">{r.name}</div>
            <div class="truncate font-mono text-[11px] text-dark-2">{r.base} · {r.sub}</div>
          </div>
          <span class="ml-auto rounded-full px-2.5 py-1 font-mono text-[10px] font-semibold {status[r.state].cls}">
            {status[r.state].label}
          </span>
        </div>

        <div class="p-3.5">
          {#if r.state === 'training'}
            <div class="h-1.5 overflow-hidden rounded-full bg-dark-7">
              <div class="h-full bg-amber-400" style={`width:${r.pct}%`}></div>
            </div>
            <div class="mt-2 font-mono text-[11px] text-dark-2">{r.progress}</div>
          {:else}
            <div class="grid grid-cols-4 gap-1.5">
              {#each Array(4) as _, i (i)}
                <div class="aspect-square rounded-md bg-gradient-to-br from-primary/15 to-dark-7"></div>
              {/each}
            </div>
          {/if}

          <div class="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onclick={() => onOpen(r.name)}>Open</Button>
            {#if r.state === 'ready' || r.state === 'published'}
              <Button variant="outline" size="sm">🎨 Generate</Button>
            {/if}
            {#if r.state === 'ready'}
              <Button variant="outline" size="sm">Train further</Button>
            {/if}
            {#if r.state !== 'failed'}
              <Button variant="outline" size="sm">Remix</Button>
            {/if}
            {#if r.state === 'failed'}
              <Button variant="outline" size="sm">Retry</Button>
            {/if}
          </div>
        </div>
      </div>
    {/each}
  </div>
</section>
