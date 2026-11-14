import { describe, expect, it } from 'vitest';
import {
  blockedForSignal,
  isReviewBatchId,
  matchesSuspectTerm,
  newReviewBatchId,
  normalizeReviewText,
  parseBlockedForPatterns,
  parseReviewBatchRecord,
  parseSuspectTerms,
} from '../review-batch';
import vectors from './fixtures/review-terms-vectors.json';

// Placeholder terms and patterns: the real lists are private and never in the repo.
const TERMS = parseSuspectTerms('# comment\nalpha\nbeta gamma\n')!;

describe('matchesSuspectTerm', () => {
  it('matches a term as a whole word, through case, width and punctuation', () => {
    expect(matchesSuspectTerm(['see ALPHA here'], TERMS)).toBe(true);
    expect(matchesSuspectTerm(['ａｌｐｈａ'], TERMS)).toBe(true);
    expect(matchesSuspectTerm(['beta--gamma!'], TERMS)).toBe(true);
    expect(matchesSuspectTerm(['x', 'Alpha.'], TERMS)).toBe(true);
    expect(matchesSuspectTerm(['al​p­ha'], TERMS)).toBe(true);
  });

  it('does not match inside a word or a split phrase', () => {
    expect(matchesSuspectTerm(['alphabet'], TERMS)).toBe(false);
    expect(matchesSuspectTerm(['beta and gamma'], TERMS)).toBe(false);
    expect(matchesSuspectTerm([], TERMS)).toBe(false);
  });

  it('an absent or comment-only list parses to null, never to an empty list', () => {
    expect(parseSuspectTerms(undefined)).toBeNull();
    expect(parseSuspectTerms('# only\n\n')).toBeNull();
  });
});

const PATTERNS = parseBlockedForPatterns(
  '# header comment\n# signal\n^sig.*$\n# known-non-minor\n^benign$\n^bene.*$\n'
)!;

describe('blockedForSignal', () => {
  it('no blockedFor is no signal', () => {
    expect(blockedForSignal(null, PATTERNS)).toBe(false);
  });

  it('the fixed non-minor reasons and known-non-minor patterns are clean', () => {
    expect(blockedForSignal('moderated', PATTERNS)).toBe(false);
    expect(blockedForSignal('TOS', PATTERNS)).toBe(false);
    expect(blockedForSignal('AiNotVerified', PATTERNS)).toBe(false);
    expect(blockedForSignal(' Benign , moderated', PATTERNS)).toBe(false);
  });

  it('an unknown value, a signal value, or one bad value in a list is a signal', () => {
    expect(blockedForSignal('CSAM', PATTERNS)).toBe(true);
    expect(blockedForSignal('never seen', PATTERNS)).toBe(true);
    expect(blockedForSignal('benign,signal word', PATTERNS)).toBe(true);
    expect(blockedForSignal('', PATTERNS)).toBe(true);
  });

  it('a signal pattern wins over a known-non-minor one', () => {
    const both = parseBlockedForPatterns('# signal\n^bene$\n# known-non-minor\n^bene$')!;
    expect(blockedForSignal('bene', both)).toBe(true);
  });

  it('without patterns, every value but the fixed reasons is a signal', () => {
    expect(blockedForSignal('benign', null)).toBe(true);
    expect(blockedForSignal('moderated', null)).toBe(false);
  });

  it('refuses a pattern list it cannot read, so the caller fails closed', () => {
    expect(parseBlockedForPatterns(undefined)).toBeNull();
    expect(parseBlockedForPatterns('^no header$')).toBeNull();
    expect(parseBlockedForPatterns('# signal\n(unclosed')).toBeNull();
  });
});

describe('review batch ids and records', () => {
  it('a new id is 22 base64url characters and two are not equal', () => {
    const id = newReviewBatchId();
    expect(isReviewBatchId(id)).toBe(true);
    expect(id).not.toBe(newReviewBatchId());
    expect(isReviewBatchId(`${id}x`)).toBe(false);
  });

  const record = {
    ids: [1, 2],
    tier: 'general',
    declared: false,
    viewer: 5,
    createdBy: 6,
    keyId: 7,
    seat: null,
    createdAt: 1,
  };

  it('reads a well-formed record and refuses a damaged one', () => {
    expect(parseReviewBatchRecord(JSON.stringify(record))).toEqual(record);
    expect(parseReviewBatchRecord(JSON.stringify({ ...record, tier: 'other' }))).toBeNull();
    expect(parseReviewBatchRecord(JSON.stringify({ ...record, ids: [] }))).toBeNull();
    expect(parseReviewBatchRecord(JSON.stringify({ ...record, ids: [1.5] }))).toBeNull();
    expect(parseReviewBatchRecord(JSON.stringify({ ...record, declared: 'no' }))).toBeNull();
    expect(parseReviewBatchRecord('{')).toBeNull();
    expect(parseReviewBatchRecord(null)).toBeNull();
  });
});

// The hub matches card text with its own implementation; these vectors are shared with it
// (crates/agent-server/tests/data/review-terms-vectors.json), so a drift fails here.

describe('the vectors shared with the hub', () => {
  it.each(vectors.normalize)('normalizes $note', ({ in: input, out }) => {
    expect(normalizeReviewText(input)).toBe(out);
  });
  it.each(vectors.match)('matches $text against $terms', ({ terms, text, matched }) => {
    expect(matchesSuspectTerm([text], parseSuspectTerms(terms.join('\n'))!)).toBe(matched);
  });
});
