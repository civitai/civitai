<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { SOURCE_LABELS, sourceKey } from '$lib/minor-flags/appeal-filters';

  let {
    row,
    size = 'sm',
  }: {
    row: { flagSource: string | null; minor: boolean; poi: boolean };
    size?: 'sm' | 'md';
  } = $props();

  const TONE = {
    'text-scan': 'border-violet-500/40 bg-violet-500/15 text-violet-300',
    hash: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
    moderator: 'border-slate-400/40 bg-slate-400/15 text-slate-200',
    none: 'border-dark-4 bg-transparent text-dark-2',
  } as const;

  const source = $derived(sourceKey(row.flagSource));
  const sizing = $derived(size === 'md' ? 'h-6 px-2.5 text-sm' : 'h-5 px-2 text-xs');
</script>

<Badge variant="outline" class={cn(sizing, TONE[source])}>{SOURCE_LABELS[source]}</Badge>
{#if row.minor}
  <Badge variant="outline" class={cn(sizing, 'border-red-500/40 bg-red-500/15 text-red-300')}>
    Minor
  </Badge>
{/if}
{#if row.poi}
  <Badge
    variant="outline"
    class={cn(sizing, 'border-orange-500/40 bg-orange-500/15 text-orange-300')}
  >
    Real person
  </Badge>
{/if}
{#if !row.minor && !row.poi}
  <Badge
    variant="outline"
    class={cn(sizing, 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300')}
  >
    No longer flagged
  </Badge>
{/if}
