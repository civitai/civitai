<script lang="ts">
  import type { Snippet } from 'svelte';
  import { IconBolt } from '@tabler/icons-svelte';
  import { Card, CardContent } from '@civitai/ui/components/ui/card/index.js';

  // Tabler ships legacy class components, so mirror nav.ts and type the icon slot as `typeof` an icon.
  type TablerIcon = typeof IconBolt;

  // The shared stat tile used across the dashboard + analytics: a coloured icon + label header, then whatever value
  // / delta / hint the caller renders as children. The header style lives here so every stat card matches (change
  // it once and it changes everywhere). Callers space their body with `mt-1` (value) / `mt-2` (hint).
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
