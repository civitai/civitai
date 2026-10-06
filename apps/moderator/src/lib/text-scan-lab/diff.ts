export type DiffLine = { op: 'same' | 'add' | 'del'; text: string };

/** Longest common subsequence. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const n = endA - start;
  const m = endB - start;
  // lcs[i * (m + 1) + j] = LCS length of a[start + i..endA) and b[start + j..endB).
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] =
        a[start + i] === b[start + j]
          ? lcs[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
    }
  }

  const out: DiffLine[] = a.slice(0, start).map((text) => ({ op: 'same', text }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      out.push({ op: 'same', text: a[start + i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) {
      out.push({ op: 'del', text: a[start + i] });
      i++;
    } else {
      out.push({ op: 'add', text: b[start + j] });
      j++;
    }
  }
  for (; i < n; i++) out.push({ op: 'del', text: a[start + i] });
  for (; j < m; j++) out.push({ op: 'add', text: b[start + j] });
  for (const text of a.slice(endA)) out.push({ op: 'same', text });
  return out;
}
