import { isSemanticDefinition, type SemanticModelRule } from './model-rules';

export const DEFAULT_RULE_DESCRIPTION = 'Takedown request';
export const LIKENESS_RULE_DESCRIPTION = 'Real person who has claimed their likeness';

// Likeness reasons repeat one sentence per claim and ship in the prompt with every rule, so they are
// shortened there; the full text stays as the internal note.
const LIKENESS_REASON = /has claimed their (digital )?likeness/i;

const descriptionFor = (reason: string | null | undefined) => {
  const text = reason?.trim();
  if (!text) return DEFAULT_RULE_DESCRIPTION;
  return LIKENESS_REASON.test(text) ? LIKENESS_RULE_DESCRIPTION : text;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const MAX_EXPANSIONS = 50;
const METACHARACTERS = /[[\]{}()*+?^$\\|]/;

class Unparseable extends Error {}

/** Expands one regex body into the literal strings it matches. Throws `Unparseable` on anything else. */
function expand(body: string): string[] {
  let i = 0;

  const cross = (left: string[], right: string[]) => {
    if (left.length * right.length > MAX_EXPANSIONS) throw new Unparseable();
    return left.flatMap((l) => right.map((r) => l + r));
  };

  function sequence(): string[] {
    let result = [''];
    while (i < body.length && body[i] !== '|' && body[i] !== ')') {
      if (body.startsWith('(?:', i) || body[i] === '(') {
        i += body.startsWith('(?:', i) ? 3 : 1;
        const inner = alternation();
        if (body[i] !== ')') throw new Unparseable();
        i++;
        result = cross(result, inner);
      } else if (body[i] === '\\') {
        // `\.` and friends are literal punctuation; `\s`, `\d`, `\w` are classes we cannot list.
        const escaped = body[i + 1];
        if (escaped === undefined || /[A-Za-z0-9]/.test(escaped)) throw new Unparseable();
        i += 2;
        result = result.map((r) => r + escaped);
      } else {
        const ch = body[i++];
        result = result.map((r) => r + ch);
      }
    }
    return result;
  }

  function alternation(): string[] {
    const all = [...sequence()];
    while (body[i] === '|') {
      i++;
      all.push(...sequence());
    }
    if (all.length > MAX_EXPANSIONS) throw new Unparseable();
    return all;
  }

  const result = alternation();
  if (i < body.length) throw new Unparseable();
  return result;
}

const matchBody = (match: string): string => {
  if (match.startsWith('/')) {
    const end = match.lastIndexOf('/');
    if (end > 0) return match.slice(1, end);
  }
  return match;
};

function literalsOf(match: string): { body: string; literals: string[] | null } {
  const body = matchBody(match);
  const stripped = body
    .replaceAll('(?:\\b|\\s)', '')
    .replaceAll('\\b', '')
    .replace(/\[\\s\\-_\][*+]/g, ' ');
  try {
    const literals = expand(stripped)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 0);
    if (!literals.length || literals.some((s) => METACHARACTERS.test(s)))
      return { body, literals: null };
    return { body, literals };
  } catch (e) {
    if (e instanceof Unparseable) return { body, literals: null };
    throw e;
  }
}

function isAnyOfContent(definition: unknown): boolean {
  if (!isRecord(definition)) return false;
  if (definition.type === 'content') return true;
  return (
    definition.type === 'or' &&
    Array.isArray(definition.rules) &&
    definition.rules.every(isAnyOfContent)
  );
}

function collectMatches(definition: unknown, out: string[] = []): string[] {
  if (!isRecord(definition)) return out;
  if (definition.type === 'content' && typeof definition.match === 'string')
    out.push(definition.match);
  if (Array.isArray(definition.rules)) for (const r of definition.rules) collectMatches(r, out);
  return out;
}

/**
 * A pattern that does not reduce to plain text keeps its raw body as the subject and is flagged
 * `needsAttention` for a person to rewrite. So is any rule whose meaning a subject and aliases cannot
 * carry: an `and`, or a tag or property condition.
 */
export function convertLegacyModelRule(
  definition: unknown,
  reason: string | null | undefined
): SemanticModelRule {
  if (isSemanticDefinition(definition)) return definition;

  const matches = collectMatches(definition);
  const parsed = matches.map(literalsOf);
  let needsAttention = parsed.some((p) => p.literals === null) || !isAnyOfContent(definition);

  let subject: string;
  const first = parsed[0];
  if (first?.literals) subject = first.literals[0];
  else {
    subject = first?.body.trim() || JSON.stringify(definition).slice(0, 200);
    needsAttention = true;
  }

  const seen = new Set([subject.toLowerCase()]);
  const aliases: string[] = [];
  parsed.forEach((p, index) => {
    const literals = index === 0 && p.literals ? p.literals.slice(1) : p.literals ?? [];
    for (const alias of literals) {
      const key = alias.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      aliases.push(alias);
    }
  });

  return {
    type: 'semantic',
    subject,
    description: descriptionFor(reason),
    aliases,
    legacyMatch: definition,
    ...(needsAttention ? { needsAttention: true } : {}),
  };
}
