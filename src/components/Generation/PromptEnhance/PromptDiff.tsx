import { Text } from '@mantine/core';
import { useMemo } from 'react';

export type DiffSegment = {
  type: 'equal' | 'added' | 'removed';
  value: string;
};

/**
 * Simple word-level diff using longest common subsequence.
 * Splits on whitespace boundaries to produce readable prompt diffs.
 */
export function computeWordDiff(oldText: string, newText: string): DiffSegment[] {
  const oldWords = oldText.split(/(\s+)/);
  const newWords = newText.split(/(\s+)/);

  // Build LCS table
  const m = oldWords.length;
  const n = newWords.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldWords[i - 1] === newWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff segments
  const segments: DiffSegment[] = [];
  let i = m;
  let j = n;

  const raw: DiffSegment[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      raw.push({ type: 'equal', value: oldWords[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.push({ type: 'added', value: newWords[j - 1] });
      j--;
    } else {
      raw.push({ type: 'removed', value: oldWords[i - 1] });
      i--;
    }
  }

  raw.reverse();

  // Merge consecutive segments of the same type
  for (const seg of raw) {
    const last = segments[segments.length - 1];
    if (last && last.type === seg.type) {
      last.value += seg.value;
    } else {
      segments.push({ ...seg });
    }
  }

  return segments;
}

const diffClassMap = {
  added: 'rounded-sm bg-green-1 text-green-8 dark:bg-green-9/30 dark:text-green-4',
  removed: 'rounded-sm bg-red-1 text-red-8 line-through dark:bg-red-9/30 dark:text-red-4',
  equal: '',
} as const;

const triggerWordClass =
  'rounded-sm bg-yellow-1 text-yellow-9 dark:bg-yellow-9/30 dark:text-yellow-4 underline decoration-yellow-5 decoration-dotted';

/**
 * Splits text into fragments, marking trigger word matches.
 * Returns an array of { text, isTrigger } segments.
 */
function splitByTriggerWords(
  text: string,
  triggerWords: string[]
): { text: string; isTrigger: boolean }[] {
  if (!triggerWords.length) return [{ text, isTrigger: false }];

  // Build a regex matching any trigger word (case-insensitive, word-boundary-ish)
  const escaped = triggerWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(pattern);

  const triggerLower = new Set(triggerWords.map((w) => w.toLowerCase()));
  return parts
    .filter((p) => p !== '')
    .map((p) => ({
      text: p,
      isTrigger: triggerLower.has(p.toLowerCase()),
    }));
}

type PromptDiffProps = {
  oldText: string;
  newText: string;
  triggerWords?: string[];
};

export function PromptDiff({ oldText, newText, triggerWords }: PromptDiffProps) {
  const segments = useMemo(() => computeWordDiff(oldText, newText), [oldText, newText]);
  const tw = triggerWords ?? [];

  return (
    <Text size="sm" className="whitespace-pre-wrap rounded-md bg-gray-1 p-3 dark:bg-dark-6">
      {segments.map((seg, i) => {
        const baseClass = diffClassMap[seg.type];

        if (!tw.length) {
          return (
            <span key={i} className={baseClass || undefined}>
              {seg.value}
            </span>
          );
        }

        const fragments = splitByTriggerWords(seg.value, tw);
        return fragments.map((frag, j) => (
          <span
            key={`${i}-${j}`}
            className={frag.isTrigger ? triggerWordClass : baseClass || undefined}
          >
            {frag.text}
          </span>
        ));
      })}
    </Text>
  );
}
