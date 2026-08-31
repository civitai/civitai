<script lang="ts">
  import type { Snippet } from 'svelte';
  import { IconBolt } from '@tabler/icons-svelte';
  import { Card, CardContent } from '@civitai/ui/components/ui/card/index.js';

  // Tabler icons are legacy class components; type the slot as `typeof` an icon (matches nav.ts).
  type TablerIcon = typeof IconBolt;

  // Shared stat tile: the icon + label header lives here so every card matches; callers render the value/hint as
  // children (spaced with mt-1 / mt-2).
  let {
    label,
    icon: Icon,
    color,
    children,
  }: {
    label: string;
    icon?: TablerIcon;
    color?: string;
    children: Snippet;
  } = $props();
</script>

<Card>
  <CardContent>
    <div class="flex items-center gap-1.5">
      {#if Icon}<Icon size={15} {color} />{/if}
      <p class="text-xs text-dark-2">{label}</p>
    </div>
    {@render children()}
  </CardContent>
</Card>
