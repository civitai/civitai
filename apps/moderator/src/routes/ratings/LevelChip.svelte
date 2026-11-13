<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';

  let {
    label,
    tone = 'neutral',
  }: {
    label: string;
    tone?: 'neutral' | 'ask' | 'scan';
  } = $props();
</script>

<span
  class={cn(
    'inline-flex items-center rounded px-1.5 py-px text-[11px] font-semibold',
    tone === 'neutral' && 'bg-dark-5 text-white',
    tone === 'ask' && 'bg-blue-500/20 text-blue-300',
    tone === 'scan' && 'bg-amber-500/20 text-amber-300'
  )}>{label}</span
>
