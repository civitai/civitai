<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';

  let { status }: { status: string } = $props();

  const CLASS: Record<string, string> = {
    Pending: 'bg-amber-500/20 text-amber-200',
    Upheld: 'bg-red-500/20 text-red-200',
    Overturned: 'bg-emerald-500/20 text-emerald-200',
  };
</script>

<Badge variant="secondary" class={CLASS[status] ?? ''}>{status}</Badge>
