import { Text } from '@mantine/core';
import { useMemo } from 'react';

export type DiffSegment = {
  type: 'equal' | 'added' | 'removed';
  value: string;
};

/**
 * Two-level diff for AI prompts.
 * 1. Splits on comma boundaries to align phrases (prevents cross-phrase matching)
 * 2. Adjacent removed+added phrases are re-diffed at word level for granular changes
 */
export function computeWordDiff(oldText: string, newText: string): DiffSegment[] {
  // Level 1: phrase-level diff on comma boundaries
  const oldPhrases = oldText.split(/(,\s*)/);
  const newPhrases = newText.split(/(,\s*)/);
  const phraseDiff = mergeSegments(lcs(oldPhrases, newPhrases));

  // Level 2: re-diff adjacent removed+added blocks at word level
  const segments: DiffSegment[] = [];
  let i = 0;
  while (i < phraseDiff.length) {
    const seg = phraseDiff[i];

    if (seg.type === 'equal') {
      segments.push(seg);
      i++;
      continue;
    }

    // Collect adjacent removed and added text
    let removedText = '';
    let addedText = '';
    while (i < phraseDiff.length && phraseDiff[i].type !== 'equal') {
      if (phraseDiff[i].type === 'removed') removedText += phraseDiff[i].value;
      else addedText += phraseDiff[i].value;
      i++;
    }

    // If we have both removed and added, check similarity before word-diffing
    if (removedText && addedText) {
      const oldWords = removedText.split(/(\s+)/);
      const newWords = addedText.split(/(\s+)/);
      const wordDiff = lcs(oldWords, newWords);
      const equalCount = wordDiff.filter((s) => s.type === 'equal' && s.value.trim()).length;
      const maxWords = Math.max(
        oldWords.filter((w) => w.trim()).length,
        newWords.filter((w) => w.trim()).length
      );

      // Only show granular word diff if phrases share >40% of words
      if (maxWords > 0 && equalCount / maxWords > 0.4) {
        segments.push(...wordDiff);
      } else {
        segments.push({ type: 'removed', value: removedText });
        segments.push({ type: 'added', value: addedText });
      }
    } else if (removedText) {
      segments.push({ type: 'removed', value: removedText });
    } else if (addedText) {
      segments.push({ type: 'added', value: addedText });
    }
  }

  return mergeSegments(segments);
}

/** LCS-based diff on an array of tokens */
function lcs(oldTokens: string[], newTokens: string[]): DiffSegment[] {
  const m = oldTokens.length;
  const n = newTokens.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldTokens[i - 1] === newTokens[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const raw: DiffSegment[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldTokens[i - 1] === newTokens[j - 1]) {
      raw.push({ type: 'equal', value: oldTokens[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.push({ type: 'added', value: newTokens[j - 1] });
      j--;
    } else {
      raw.push({ type: 'removed', value: oldTokens[i - 1] });
      i--;
    }
  }

  raw.reverse();
  return raw;
}

/** Merge consecutive segments of the same type */
function mergeSegments(raw: DiffSegment[]): DiffSegment[] {
  const segments: DiffSegment[] = [];
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

/** Compute similarity ratio (0–1) from diff segments based on equal character count */
function getSimilarityRatio(segments: DiffSegment[]): number {
  let equalChars = 0;
  let totalChars = 0;
  for (const seg of segments) {
    const len = seg.value.trim().length;
    totalChars += len;
    if (seg.type === 'equal') equalChars += len;
  }
  return totalChars === 0 ? 1 : equalChars / totalChars;
}

/** Threshold below which we switch to stacked layout */
const STACKED_THRESHOLD = 0.4;

type PromptDiffProps = {
  oldText: string;
  newText: string;
  triggerWords?: string[];
};

export function PromptDiff({ oldText, newText, triggerWords }: PromptDiffProps) {
  const segments = useMemo(() => computeWordDiff(oldText, newText), [oldText, newText]);
  const similarity = useMemo(() => getSimilarityRatio(segments), [segments]);
  const tw = triggerWords ?? [];

  if (similarity < STACKED_THRESHOLD) {
    return <StackedDiff segments={segments} triggerWords={tw} />;
  }

  return <InlineDiff segments={segments} triggerWords={tw} />;
}

/** Inline interleaved diff — good for minor edits */
function InlineDiff({
  segments,
  triggerWords,
}: {
  segments: DiffSegment[];
  triggerWords: string[];
}) {
  return (
    <Text size="sm" className="whitespace-pre-wrap rounded-md bg-gray-1 p-3 dark:bg-dark-6">
      {segments.map((seg, i) => {
        const baseClass = diffClassMap[seg.type];

        if (!triggerWords.length) {
          return (
            <span key={i} className={baseClass || undefined}>
              {seg.value}
            </span>
          );
        }

        const fragments = splitByTriggerWords(seg.value, triggerWords);
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

const stackedHighlightMap = {
  removed: 'rounded-sm bg-red-1/60 dark:bg-red-9/20',
  added: 'rounded-sm bg-green-1/60 dark:bg-green-9/20',
} as const;

/** Stacked original/enhanced layout — good for heavy restructuring */
function StackedDiff({
  segments,
  triggerWords,
}: {
  segments: DiffSegment[];
  triggerWords: string[];
}) {
  // For the original text, highlight words that were removed
  const oldSegments = segments.filter((s) => s.type !== 'added');
  // For the enhanced text, highlight words that were added
  const newSegments = segments.filter((s) => s.type !== 'removed');

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Text size="xs" fw={600} c="dimmed" mb={2}>
          Original
        </Text>
        <Text size="sm" className="whitespace-pre-wrap rounded-md bg-gray-1 p-3 dark:bg-dark-6">
          {oldSegments.map((seg, i) => {
            const highlight = seg.type === 'removed' ? stackedHighlightMap.removed : undefined;
            if (!triggerWords.length) {
              return (
                <span key={i} className={highlight}>
                  {seg.value}
                </span>
              );
            }
            const fragments = splitByTriggerWords(seg.value, triggerWords);
            return fragments.map((frag, j) => (
              <span key={`${i}-${j}`} className={frag.isTrigger ? triggerWordClass : highlight}>
                {frag.text}
              </span>
            ));
          })}
        </Text>
      </div>
      <div>
        <Text size="xs" fw={600} c="dimmed" mb={2}>
          Enhanced
        </Text>
        <Text size="sm" className="whitespace-pre-wrap rounded-md bg-gray-1 p-3 dark:bg-dark-6">
          {newSegments.map((seg, i) => {
            const highlight = seg.type === 'added' ? stackedHighlightMap.added : undefined;
            if (!triggerWords.length) {
              return (
                <span key={i} className={highlight}>
                  {seg.value}
                </span>
              );
            }
            const fragments = splitByTriggerWords(seg.value, triggerWords);
            return fragments.map((frag, j) => (
              <span key={`${i}-${j}`} className={frag.isTrigger ? triggerWordClass : highlight}>
                {frag.text}
              </span>
            ));
          })}
        </Text>
      </div>
    </div>
  );
}
