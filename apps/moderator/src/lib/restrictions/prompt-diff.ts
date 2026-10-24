export type DiffPart = { kind: 'same' | 'added' | 'removed'; text: string };

/** Past this many token comparisons the table is not worth building; the middle is shown as a block. */
const MAX_CELLS = 2_000_000;

const tokens = (text: string) => text.match(/\s*\S+\s*/g) ?? [];

const push = (parts: DiffPart[], kind: DiffPart['kind'], text: string) => {
  const last = parts.at(-1);
  if (last?.kind === kind) last.text += text;
  else parts.push({ kind, text });
};

/** Word-level diff of a source prompt against the submitted one. `same` and `added` text rebuilds the submitted prompt exactly. */
export function promptDiff(source: string, submitted: string): DiffPart[] {
  const a = tokens(source);
  const b = tokens(submitted);
  const key = (t: string) => t.trim();

  let head = 0;
  while (head < a.length && head < b.length && key(a[head]) === key(b[head])) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    key(a[a.length - 1 - tail]) === key(b[b.length - 1 - tail])
  )
    tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const parts: DiffPart[] = [];

  push(parts, 'same', b.slice(0, head).join(''));

  if (midA.length * midB.length > MAX_CELLS) {
    push(parts, 'removed', midA.join(''));
    push(parts, 'added', midB.join(''));
  } else {
    // lcs[i][j] is the longest common run of midA[i..] and midB[j..].
    const lcs = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
    for (let i = midA.length - 1; i >= 0; i--)
      for (let j = midB.length - 1; j >= 0; j--)
        lcs[i][j] =
          key(midA[i]) === key(midB[j])
            ? lcs[i + 1][j + 1] + 1
            : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (key(midA[i]) === key(midB[j])) {
        push(parts, 'same', midB[j]);
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) push(parts, 'removed', midA[i++]);
      else push(parts, 'added', midB[j++]);
    }
    while (i < midA.length) push(parts, 'removed', midA[i++]);
    while (j < midB.length) push(parts, 'added', midB[j++]);
  }

  push(parts, 'same', b.slice(b.length - tail).join(''));
  return parts.filter((p) => p.text !== '');
}
