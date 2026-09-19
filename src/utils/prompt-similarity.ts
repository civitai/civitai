function cleanText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/<(?:\/?p|img|src|=|"|:|\.|\-|_)>/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 0);
}

type TFIDFMap = Map<string, number>;

function buildTFIDF(tokensA: string[], tokensB: string[]): [TFIDFMap, TFIDFMap, string[]] {
  const docs = [tokensA, tokensB];
  const vocab = Array.from(new Set([...tokensA, ...tokensB]));

  // Sets, not `Array.includes`: that made this O(vocab × tokens), and one side of
  // the server's comparison is a stored prompt whose length nothing bounds.
  const docSets = docs.map((doc) => new Set(doc));
  const docFreq: Record<string, number> = {};
  vocab.forEach((word) => {
    docFreq[word] = docSets.reduce((count, set) => (set.has(word) ? count + 1 : count), 0);
  });

  function tfidfVector(tokens: string[]): TFIDFMap {
    const tfidf = new Map<string, number>();
    const termFreq: Record<string, number> = {};
    tokens.forEach((t) => (termFreq[t] = (termFreq[t] ?? 0) + 1));

    for (const word of vocab) {
      const tf = (termFreq[word] ?? 0) / tokens.length;
      const idf = Math.log(1 + docs.length / (1 + (docFreq[word] ?? 0)));
      tfidf.set(word, tf * idf);
    }
    return tfidf;
  }

  return [tfidfVector(tokensA), tfidfVector(tokensB), vocab];
}

function cosineFromMaps(vecA: TFIDFMap, vecB: TFIDFMap, vocab: string[]): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (const word of vocab) {
    const a = vecA.get(word) ?? 0;
    const b = vecB.get(word) ?? 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }

  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

function harmonicMean(a: number, b: number): number {
  return a + b > 0 ? (2 * a * b) / (a + b) : 0;
}

/**
 * 🔴 A money gate, not a similarity preference: a submission that clears it
 * enters a creator's review queue without paying. Read only through
 * `promptDerivationHolds`; `no-divergent-prompt-derivation` fails on a second copy
 * or a second route to a threshold.
 */
export const PROMPT_DERIVATION_THRESHOLD = 0.75;

/**
 * Longer input is truncated before comparison. The similarity is still
 * super-linear in token count, and the server compares against a stored prompt
 * that the upload path does not bound, so this is the CPU ceiling for one check.
 * Matches the generator's own prompt cap, so nothing a user can submit is cut.
 */
const MAX_COMPARED_PROMPT_CHARS = 6000;

function promptSimilarity(p1: string, p2: string) {
  const tokensA = cleanText(p1);
  const tokensB = cleanText(p2);

  // Every term below divides by a token count or a set size.
  if (!tokensA.length || !tokensB.length)
    return { cosine: 0, containment: 0, adjustedCosine: 0, similar: false };

  const [vecA, vecB, vocab] = buildTFIDF(tokensA, tokensB);
  const cosine = cosineFromMaps(vecA, vecB, vocab);

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const shared = [...setA].filter((t) => setB.has(t)).length;
  const containment = shared / Math.max(setA.size, setB.size);

  const adjustedCosine = harmonicMean(cosine, containment);

  return {
    cosine,
    containment,
    adjustedCosine,
    similar: adjustedCosine >= PROMPT_DERIVATION_THRESHOLD,
  };
}

/**
 * Whether `current` is still derived from `source`.
 *
 * No options parameter, on purpose: this is the derivation the free-submission
 * gate spends, and a caller that could pass its own cutoff would be a second
 * threshold that nothing pins. Both readers — the client's `remixClaimState` and
 * the server's submit-time check — come through here, so they cannot disagree.
 *
 * An empty side is not a drift verdict. `promptSimilarity` scores it 0, which
 * would read as "they changed everything" when the truth is that there is nothing
 * to compare; callers decide what an absent prompt means.
 */
export function promptDerivationHolds(
  source: string,
  current: string
): { holds: boolean; score: number } {
  const { similar, adjustedCosine } = promptSimilarity(
    source.slice(0, MAX_COMPARED_PROMPT_CHARS),
    current.slice(0, MAX_COMPARED_PROMPT_CHARS)
  );
  return { holds: similar, score: adjustedCosine };
}
