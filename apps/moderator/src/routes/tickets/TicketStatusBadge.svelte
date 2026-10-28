<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { STATUS } from '$lib/tickets/statuses';

  let { status, label }: { status: number; label: string } = $props();

  // Amber: parked with a mod lead or dev. Blue: needs an agent now.
  const TONE: Record<number, string> = {
    [STATUS.open]: 'border-blue-400 text-blue-300',
    [STATUS.customerResponded]: 'border-blue-400 text-blue-300',
    [STATUS.waitingOnMod]: 'border-amber-400 text-amber-300',
    [STATUS.waitingOnDev]: 'border-amber-400 text-amber-300',
  };
</script>

<Badge variant="outline" class="bg-transparent whitespace-nowrap {TONE[status] ?? 'border-dark-4 text-dark-1'}"
  >{label}</Badge
>
