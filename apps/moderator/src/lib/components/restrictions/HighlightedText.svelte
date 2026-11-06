<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';

  let {
    text,
    highlight,
    class: className,
  }: {
    text: string;
    /** Highlighted by LITERAL, case-insensitive search. Never compiled to a regex — on these pages it
     *  originates from user-supplied prompt text. */
    highlight?: string | string[] | null;
    class?: string;
  } = $props();

  type Part = { text: string; hit: boolean };

  const parts = $derived.by((): Part[] => {
    const needles = [highlight ?? []]
      .flat()
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
      // Longest first so a needle that contains another wins at the same position.
      .sort((a, b) => b.length - a.length);
    if (!needles.length) return [{ text, hit: false }];

    const haystack = text.toLowerCase();
    const out: Part[] = [];
    let at = 0;
    let cursor = 0;
    for (;;) {
      let found = -1;
      let len = 0;
      for (const n of needles) {
        const i = haystack.indexOf(n, cursor);
        if (i !== -1 && (found === -1 || i < found)) {
          found = i;
          len = n.length;
        }
      }
      if (found === -1) break;
      if (found > at) out.push({ text: text.slice(at, found), hit: false });
      out.push({ text: text.slice(found, found + len), hit: true });
      at = cursor = found + len;
    }
    if (!out.length) return [{ text, hit: false }];
    if (at < text.length) out.push({ text: text.slice(at), hit: false });
    return out;
  });
</script>

<p
  class={cn('text-sm leading-relaxed break-words whitespace-pre-wrap', className)}
>{#each parts as part, i (`${i}:${part.text}`)}{#if part.hit}<mark
      class="rounded-sm bg-amber-500/30 px-0.5 text-amber-100">{part.text}</mark
    >{:else}{part.text}{/if}{/each}</p>
