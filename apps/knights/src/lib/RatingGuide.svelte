<script lang="ts">
  import { page } from '$app/state';
  import { levelName, prohibitedContentUrl } from './rating-guide';

  type Example = { id: number; src: string; width: number | null; height: number | null };

  let {
    guide,
    plain = false,
  }: {
    guide: { level: number; label: string; description: string; examples?: Example[] }[];
    /** Rows that are not rating levels: no level names and no Blocked styling or link. */
    plain?: boolean;
  } = $props();
</script>

<ul class="guide">
  {#each guide as entry (entry.level)}
    {@const blocked = !plain && entry.label.toLowerCase() === 'blocked'}
    {@const name = plain ? null : levelName(entry.label)}
    <li class="row" class:blocked>
      <span class="chip">{entry.label}</span>
      <div class="meaning">
        {#if name}<p class="name">{name}</p>{/if}
        <p class="description">{entry.description}</p>
        {#if blocked && page.data.civitaiUrl}
          <a class="rules" href={prohibitedContentUrl(page.data.civitaiUrl)} target="_blank" rel="noopener noreferrer"
            >See the full list of prohibited content</a
          >
        {/if}
      </div>
      {#if entry.examples?.length}
        <ul class="examples" aria-label={`${entry.label} examples`}>
          {#each entry.examples as example (example.id)}
            <li>
              <img
                src={example.src}
                alt={`An image rated ${entry.label}`}
                width={example.width ?? undefined}
                height={example.height ?? undefined}
                loading="lazy"
                decoding="async"
              />
            </li>
          {/each}
        </ul>
      {/if}
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
    flex-wrap: wrap;
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
    flex: 1 1 0;
    min-width: 0;
  }
  /* A swipeable strip of examples under the meaning, as the original game's guide had. */
  .examples {
    display: flex;
    flex-basis: 100%;
    gap: 8px;
    margin: -6px 0 0;
    padding: 0 0 6px;
    overflow-x: auto;
    list-style: none;
    scroll-snap-type: x mandatory;
    overscroll-behavior-x: contain;
  }
  .examples li {
    flex: none;
    scroll-snap-align: start;
  }
  .examples img {
    display: block;
    width: auto;
    height: 160px;
    max-width: 240px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 4px;
    background: var(--io-bg);
    object-fit: cover;
  }
  .meaning p {
    margin: 0;
  }
  .rules {
    display: inline-block;
    margin-top: 4px;
    color: var(--io-crimson-text);
    font: 600 14px/1.4 var(--io-font-ui);
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
    .examples img {
      height: 132px;
      max-width: 180px;
    }
  }
</style>
