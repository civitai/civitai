<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';

  let { status, outline = false }: { status: string; outline?: boolean } = $props();

  const CLASS: Record<string, string> = {
    Pending: 'bg-amber-500/20 text-amber-200',
    Upheld: 'bg-red-500/20 text-red-200',
    Overturned: 'bg-emerald-500/20 text-emerald-200',
  };
  const OUTLINE: Record<string, string> = {
    Pending: 'border-amber-400 text-amber-300',
    Upheld: 'border-red-400 text-red-300',
    Overturned: 'border-emerald-400 text-emerald-300',
  };
</script>

{#if outline}
  <Badge variant="outline" class="bg-transparent {OUTLINE[status] ?? ''}">{status}</Badge>
{:else}
  <Badge variant="secondary" class={CLASS[status] ?? ''}>{status}</Badge>
{/if}
