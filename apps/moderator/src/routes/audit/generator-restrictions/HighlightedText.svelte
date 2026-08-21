<script lang="ts">
  let {
    text,
    highlight,
  }: {
    text: string;
    /** Highlighted by LITERAL, case-insensitive search. Never compiled to a regex — on these pages it
     *  originates from user-supplied prompt text. */
    highlight?: string | null;
  } = $props();

  type Part = { text: string; hit: boolean };

  const parts = $derived.by((): Part[] => {
    const needle = highlight?.trim();
    if (!needle) return [{ text, hit: false }];

    const haystack = text.toLowerCase();
    const lower = needle.toLowerCase();
    const out: Part[] = [];
    let at = 0;
    for (;;) {
      const found = haystack.indexOf(lower, at);
      if (found === -1) break;
      if (found > at) out.push({ text: text.slice(at, found), hit: false });
      out.push({ text: text.slice(found, found + needle.length), hit: true });
      at = found + needle.length;
    }
    if (!out.length) return [{ text, hit: false }];
    if (at < text.length) out.push({ text: text.slice(at), hit: false });
    return out;
  });
</script>

<p
  class="text-sm leading-relaxed break-words whitespace-pre-wrap"
>{#each parts as part, i (`${i}:${part.text}`)}{#if part.hit}<mark
      class="rounded-sm bg-amber-500/30 px-0.5 text-amber-100">{part.text}</mark
    >{:else}{part.text}{/if}{/each}</p>
