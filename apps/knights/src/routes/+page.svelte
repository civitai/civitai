<script lang="ts">
  import Icon from '$lib/Icon.svelte';
  import { glow, parallax } from '$lib/pointer-fx';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const pillars = [
    { icon: 'scan-eye', label: 'Judge images', long: 'Rate each one PG to XXX.', short: 'PG to XXX' },
    {
      icon: 'trending-up',
      label: 'Rise through the ranks',
      long: 'Acolyte, Knight, Templar, Paladin.',
      short: 'Acolyte to Paladin',
    },
    { icon: 'coins', label: 'Earn gold', long: 'Every right judgment pays.', short: 'for every right judgment' },
  ] as const;
  // Fixed per-ember offsets, so the server and the browser render the same sparks.
  const embers = Array.from({ length: 14 }, (_, i) => ({
    left: (i * 37 + 11) % 100,
    delay: -((i * 53) % 17),
    duration: 11 + ((i * 7) % 9),
    drift: ((i * 29) % 41) - 20,
    size: 2 + (i % 3),
  }));
</script>

<svelte:head>
  <title>Knights of New Order</title>
</svelte:head>

<div class="welcome" use:parallax>
  <div class="bg" data-depth="10" aria-hidden="true"></div>
  <div class="scrim" data-depth="4" aria-hidden="true"></div>
  <div class="embers" aria-hidden="true">
    {#each embers as ember, i (i)}
      <span
        style:left="{ember.left}%"
        style:animation-delay="{ember.delay}s"
        style:animation-duration="{ember.duration}s"
        style:--drift="{ember.drift}px"
        style:width="{ember.size}px"
        style:height="{ember.size}px"
      ></span>
    {/each}
  </div>
  <div class="frame">
    <header>
      <Icon name="shield" size={22} />
      <span>Knights of New Order</span>
    </header>

    <main class="stage">
      <div class="body">
        <section class="pitch">
          <p class="kicker">A Civitai game</p>
          <h1>Judge the image.<br />Rise in the Order.</h1>
          <p class="lede long">
            Knights of New Order rate how mature images should be, so the site can show each one to the right
            people. Begin as an Acolyte, prove yourself as an apprentice, and earn rank, glory and gold for every
            judgment that holds.
          </p>
          <p class="lede short">
            Rate how mature images should be. Begin as an Acolyte, prove yourself as an apprentice, and earn rank and
            gold for every judgment that holds.
          </p>
          <div class="pillars short">
            {#each pillars as pillar (pillar.label)}
              <div class="pillar">
                <Icon name={pillar.icon} size={18} />
                <div><strong>{pillar.label}</strong><span>{pillar.short}</span></div>
              </div>
            {/each}
          </div>
          <div class="actions">
            <a class="primary" href={data.signInUrl} data-sveltekit-reload>Sign in with Civitai</a>
            <a class="secondary" href={data.civitaiUrl}>Back to Civitai</a>
          </div>
          <p class="age">Members must be 18 or older. Images may be mature.</p>
        </section>

        <div class="banner glow-card" aria-hidden="true" use:glow>
          <p class="kicker">The Order awaits</p>
          <span class="crest"><Icon name="flame" size={36} /></span>
          <strong class="rank">Acolyte</strong>
          <span class="levels">Your first rank</span>
          <p class="begin">Begin as an apprentice</p>
          <p class="sub">Every Knight was once an Acolyte.</p>
        </div>
      </div>

      <div class="pillars long">
        {#each pillars as pillar (pillar.label)}
          <div class="pillar glow-card" use:glow>
            <Icon name={pillar.icon} size={24} />
            <div><strong>{pillar.label}</strong><span>{pillar.long}</span></div>
          </div>
        {/each}
      </div>
    </main>
  </div>
</div>

<style>
  .welcome {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    min-height: 100dvh;
    isolation: isolate;
    overflow: hidden;
    background: var(--io-bg);
    padding: 0 64px 48px;
  }
  /* The photo and the scrim are their own layers, over-sized so the parallax shift never shows an edge. */
  .bg,
  .scrim {
    position: absolute;
    inset: -28px;
    z-index: -2;
    will-change: transform;
  }
  .bg {
    background: url('/images/welcome-cathedral.webp') center / cover no-repeat;
  }
  .scrim {
    z-index: -1;
    background: linear-gradient(to top, #14110df5, #14110de0 50%, #14110d99);
  }
  .embers {
    position: absolute;
    inset: 0;
    z-index: -1;
    overflow: hidden;
    pointer-events: none;
  }
  .embers span {
    position: absolute;
    bottom: -8px;
    border-radius: 50%;
    background: var(--io-gold);
    box-shadow: 0 0 6px 1px color-mix(in srgb, var(--io-gold) 70%, transparent);
    opacity: 0;
    animation: ember-rise linear infinite;
  }
  @keyframes ember-rise {
    0% {
      opacity: 0;
      transform: translate3d(0, 0, 0);
    }
    12% {
      opacity: 0.8;
    }
    70% {
      opacity: 0.35;
    }
    100% {
      opacity: 0;
      transform: translate3d(var(--drift), -85vh, 0);
    }
  }
  .glow-card {
    position: relative;
    isolation: isolate;
    overflow: hidden;
  }
  .glow-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    z-index: -1;
    width: 360px;
    height: 360px;
    margin: -180px 0 0 -180px;
    border-radius: 50%;
    background: radial-gradient(circle, color-mix(in srgb, var(--io-gold) 42%, transparent), transparent 68%);
    opacity: 0;
    transform: translate3d(var(--mx, -999px), var(--my, -999px), 0);
    transition: opacity var(--motion-base) var(--ease-out-quart);
    pointer-events: none;
  }
  .glow-card:hover::before {
    opacity: 1;
  }
  .frame {
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    width: 100%;
    max-width: 1180px;
    margin: 0 auto;
  }
  .stage {
    display: flex;
    flex: 1;
    flex-direction: column;
    justify-content: center;
    gap: 64px;
    padding-bottom: 40px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 72px;
    color: var(--io-gold);
    font: 700 15px/1 var(--io-font-display);
    letter-spacing: 2px;
    text-transform: uppercase;
  }
  .body {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 64px;
  }
  .pitch {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    flex: 1;
    gap: 22px;
    max-width: 680px;
    min-width: 0;
  }
  .kicker {
    margin: 0;
    color: var(--io-gold);
    font: 600 12px/1.2 var(--io-font-ui);
    letter-spacing: 4px;
    text-transform: uppercase;
  }
  h1 {
    margin: 0;
    color: var(--io-parchment);
    font: 700 42px/1.12 var(--io-font-display);
    letter-spacing: 1.5px;
    text-transform: uppercase;
  }
  .lede {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 21px/1.45 var(--io-font-body);
  }
  .actions {
    display: flex;
    gap: 16px;
  }
  .primary,
  .secondary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 52px;
    padding: 0 28px;
    border-radius: 4px;
    font: 700 15px/1 var(--io-font-display);
    letter-spacing: 2px;
    text-align: center;
    text-decoration: none;
    text-transform: uppercase;
  }
  .primary {
    background: var(--io-gold);
    color: var(--io-bg);
  }
  .primary:hover {
    background: color-mix(in srgb, var(--io-gold) 88%, white);
  }
  .secondary {
    border: 1.5px solid var(--io-gold);
    color: var(--io-gold);
  }
  .secondary:hover {
    background: color-mix(in srgb, var(--io-gold) 14%, transparent);
  }
  .age {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 12px/1.4 var(--io-font-ui);
  }
  .banner {
    display: flex;
    flex: none;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    width: 426px;
    padding: 28px 32px;
    border: 1.5px solid var(--io-gold);
    border-radius: 6px;
    background: linear-gradient(180deg, #3a2d12, var(--io-surface));
    text-align: center;
  }
  .crest {
    display: grid;
    place-items: center;
    width: 90px;
    height: 90px;
    border: 1.5px solid var(--io-gold);
    border-radius: 50%;
    background: var(--io-bg);
    color: var(--io-gold);
  }
  .rank {
    color: var(--io-parchment);
    font: 700 18px/1 var(--io-font-display);
    letter-spacing: 3px;
    text-transform: uppercase;
  }
  .levels {
    margin-top: -8px;
    color: var(--io-parchment-muted);
    font: 13px/1 var(--io-font-ui);
  }
  .begin {
    margin: 0;
    color: var(--io-parchment);
    font: 700 26px/1.2 var(--io-font-display);
    letter-spacing: 3px;
    text-transform: uppercase;
  }
  .sub {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 18px/1.3 var(--io-font-body);
  }
  .pillars {
    display: flex;
    gap: 48px;
  }
  .pillar {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 14px;
    min-width: 0;
    color: var(--io-gold);
  }
  .pillars.long {
    gap: 24px;
  }
  .pillars.long .pillar {
    padding: 18px 22px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 6px;
    background: color-mix(in srgb, var(--io-surface) 72%, transparent);
    transition: border-color var(--motion-base) var(--ease-out-quart);
  }
  .pillars.long .pillar:hover {
    border-color: var(--io-gold);
  }
  .banner {
    transition: border-color var(--motion-base) var(--ease-out-quart);
  }
  .pillar strong {
    display: block;
    color: var(--io-parchment);
    font: 700 14px/1.3 var(--io-font-display);
    letter-spacing: 2px;
    text-transform: uppercase;
  }
  .pillar span {
    display: block;
    color: var(--io-parchment-muted);
    font: 17px/1.3 var(--io-font-body);
  }
  .short {
    display: none;
  }

  /* Mirrors effectsAllowed() in pointer-fx.ts: keep the two in step. */
  @media (prefers-reduced-motion: reduce), (hover: none), (pointer: coarse) {
    .embers {
      display: none;
    }
    .glow-card::before {
      display: none;
    }
    .bg,
    .scrim {
      will-change: auto;
    }
  }

  @media (max-width: 62rem) {
    .banner {
      display: none;
    }
  }

  @media (max-width: 40rem) {
    .welcome {
      padding: 0 24px 28px;
    }
    header {
      height: 52px;
      font-size: 14px;
      letter-spacing: 1px;
    }
    .stage {
      justify-content: flex-end;
      padding-bottom: 20px;
    }
    .body {
      align-items: flex-end;
    }
    .pitch {
      width: 100%;
      gap: 20px;
    }
    h1 {
      font-size: 29px;
      line-height: 1.15;
      letter-spacing: 1px;
    }
    .lede {
      font-size: 18px;
      line-height: 1.4;
    }
    .long {
      display: none;
    }
    .lede.short {
      display: block;
    }
    .pillars.short {
      display: flex;
      flex-direction: column;
      gap: 10px;
      width: 100%;
    }
    .pillar {
      align-items: flex-start;
      gap: 12px;
    }
    .pillar strong {
      font-size: 12px;
      letter-spacing: 1.5px;
    }
    .pillar span {
      font-size: 15px;
    }
    .actions {
      flex-direction: column;
      width: 100%;
      gap: 20px;
    }
    .primary {
      min-height: 52px;
    }
    .secondary {
      min-height: 48px;
    }
  }
</style>
