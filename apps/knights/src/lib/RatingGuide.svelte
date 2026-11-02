<script lang="ts">
  import { levelName } from './rating-guide';

  let { guide }: { guide: { level: number; label: string; description: string }[] } = $props();
</script>

<ul class="guide">
  {#each guide as entry (entry.level)}
    {@const blocked = entry.label.toLowerCase() === 'blocked'}
    {@const name = levelName(entry.label)}
    <li class="row" class:blocked>
      <span class="chip">{entry.label}</span>
      <div class="meaning">
        {#if name}<p class="name">{name}</p>{/if}
        <p class="description">{entry.description}</p>
      </div>
    </li>
  {/each}
</ul>

<style>
  .guide {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 18px;
  }
  .chip {
    display: grid;
    flex: none;
    place-items: center;
    width: 85px;
    height: 49px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 4px;
    background: var(--io-bg);
    color: var(--io-parchment);
    font: 700 20px/1 var(--io-font-display);
  }
  .blocked .chip {
    border-color: var(--io-crimson);
    color: var(--io-crimson-text);
    font-size: 15px;
    font-variant: small-caps;
  }
  .meaning {
    min-width: 0;
  }
  .meaning p {
    margin: 0;
  }
  .name {
    color: var(--io-gold);
    font: 600 12px/1.3 var(--io-font-ui);
    letter-spacing: 3px;
    text-transform: uppercase;
  }
  .blocked .name {
    color: var(--io-crimson-text);
  }
  .description {
    color: var(--io-parchment);
    font: 400 18px/1.35 var(--io-font-body);
  }

  @media (max-width: 40rem) {
    .guide {
      gap: 12px;
    }
    .row {
      gap: 12px;
    }
    .chip {
      width: 65px;
      height: 41px;
      font-size: 17px;
    }
    .blocked .chip {
      font-size: 12px;
    }
    .name {
      font-size: 13px;
      letter-spacing: 2.5px;
    }
    .description {
      font-size: 17px;
      line-height: 1.3;
    }
  }
</style>
