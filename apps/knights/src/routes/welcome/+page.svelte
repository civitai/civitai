<script lang="ts">
  import Icon from '$lib/Icon.svelte';
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
</script>

<svelte:head>
  <title>Knights of New Order</title>
</svelte:head>

<div class="welcome">
  <header>
    <Icon name="shield" size={22} />
    <span>Knights of New Order</span>
  </header>

  <div class="body">
    <section class="pitch">
      <p class="kicker">A Civitai game</p>
      <h1>Judge the image.<br />Rise in the Order.</h1>
      <p class="lede long">
        Knights of New Order rate how mature images should be, so the site can show each one to the right
        people. Begin as an Acolyte, prove yourself in the Trials, and earn rank, glory and gold for every
        judgment that holds.
      </p>
      <p class="lede short">
        Rate how mature images should be. Begin as an Acolyte, prove yourself in the Trials, and earn rank and
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

    <aside class="banner" aria-label="The Order awaits">
      <p class="kicker">The Order awaits</p>
      <span class="crest"><Icon name="flame" size={36} /></span>
      <strong class="rank">Acolyte</strong>
      <span class="levels">Levels 21–40</span>
      <p class="begin">Begin in the Trials</p>
      <p class="sub">Every Knight was once an Acolyte.</p>
    </aside>
  </div>

  <div class="pillars long">
    {#each pillars as pillar (pillar.label)}
      <div class="pillar">
        <Icon name={pillar.icon} size={24} />
        <div><strong>{pillar.label}</strong><span>{pillar.long}</span></div>
      </div>
    {/each}
  </div>
</div>

<style>
  .welcome {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    min-height: 100dvh;
    overflow: hidden;
    background: radial-gradient(70% 60% at 72% 30%, #3a2d1288, transparent 70%),
      linear-gradient(180deg, var(--io-matte), var(--io-bg));
    padding: 0 64px 48px;
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
    flex: 1;
    align-items: center;
    justify-content: space-between;
    gap: 48px;
    padding: 40px 0;
  }
  .pitch {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
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
    .body {
      align-items: flex-end;
      padding: 24px 0 20px;
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
