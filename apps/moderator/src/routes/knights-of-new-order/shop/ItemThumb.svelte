<script lang="ts">
  import {
    IconBolt,
    IconBorderCorners,
    IconCircleDashed,
    IconCrown,
    IconMessage,
    IconPalette,
    IconPhoto,
    IconRosetteDiscount,
    IconSticker,
    IconTextSize,
  } from '@tabler/icons-svelte';
  import { cn } from '@civitai/ui/utils.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { cosmeticMedia, nameplateGradient, type Kind } from './shop-view';

  let {
    kind,
    name,
    tier = null,
    cosmeticType = null,
    cosmeticData = null,
    size = 'md',
    class: className,
  }: {
    kind: Kind;
    name: string;
    tier?: string | null;
    cosmeticType?: string | null;
    cosmeticData?: unknown;
    size?: 'sm' | 'md' | 'lg';
    class?: string;
  } = $props();

  const SIZE = { sm: 'size-8', md: 'size-11', lg: 'size-16' } as const;
  const TIER_TONE: Record<string, string> = {
    bronze: 'text-amber-600',
    silver: 'text-slate-300',
    gold: 'text-yellow-400',
  };
  const TYPE_ICON = {
    Badge: IconRosetteDiscount,
    NamePlate: IconTextSize,
    ContentDecoration: IconBorderCorners,
    ProfileDecoration: IconCircleDashed,
    ProfileBackground: IconPhoto,
    Sticker: IconSticker,
    ChatTheme: IconMessage,
  } as const;
  const media = $derived(cosmeticMedia({ cosmeticType, cosmeticData }));
  const gradient = $derived(nameplateGradient({ cosmeticType, cosmeticData }));
  const Fallback = $derived(
    TYPE_ICON[(cosmeticType ?? '') as keyof typeof TYPE_ICON] ?? IconPalette
  );
</script>

<div
  class={cn(
    'flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-dark-4 bg-dark-7',
    SIZE[size],
    className
  )}
>
  {#if kind === 'buzz_pack'}
    <IconBolt class="size-1/2 text-yellow-400" />
  {:else if kind === 'membership'}
    <IconCrown class={cn('size-1/2', TIER_TONE[tier ?? ''] ?? 'text-dark-1')} />
  {:else if media}
    <EdgeMedia
      src={media.url}
      type={media.type}
      anim={media.animated}
      {name}
      width={size === 'lg' ? 128 : 64}
      alt={name}
      class="size-full object-contain"
    />
  {:else if gradient}
    <span
      class="flex size-full items-center justify-center text-xs font-semibold text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.5)]"
      style:background={gradient}>Aa</span
    >
  {:else}
    <Fallback class="size-1/2 text-dark-2" aria-label={cosmeticType ?? 'Cosmetic'} />
  {/if}
</div>
