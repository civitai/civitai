import type { Clause } from '~/server/search/search-scope';

// Reads the Meilisearch filter expressions the site's search UI and `/api/search` send, into
// engine-neutral clauses, so the same request can be answered by another engine. It covers the
// grammar those senders use — comparisons, IN, TO, EXISTS, NOT, AND, OR, parentheses — and refuses
// anything else, which the caller answers from Meilisearch instead. It is a bridge for the engine
// comparison, not a grammar we keep: the rebuilt UI sends typed queries.

export class UnsupportedSearchRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSearchRequest';
  }
}

type Token =
  | { type: 'word'; value: string }
  | { type: 'string'; value: string }
  | { type: 'op'; value: '=' | '!=' | '>' | '>=' | '<' | '<=' }
  | { type: '(' | ')' | '[' | ']' | ',' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '(' || c === ')' || c === '[' || c === ']' || c === ',') {
      tokens.push({ type: c });
      i++;
    } else if (c === "'" || c === '"') {
      let value = '';
      i++;
      while (i < input.length && input[i] !== c) {
        if (input[i] === '\\' && i + 1 < input.length) i++;
        value += input[i++];
      }
      if (i >= input.length) throw new UnsupportedSearchRequest('unterminated string in filter');
      i++;
      tokens.push({ type: 'string', value });
    } else if (c === '!' || c === '=' || c === '>' || c === '<') {
      const two = input.slice(i, i + 2);
      const op = (['!=', '>=', '<='] as const).find((o) => o === two) ?? c;
      if (op === '!') throw new UnsupportedSearchRequest('unexpected "!" in filter');
      tokens.push({ type: 'op', value: op as '=' | '>' | '<' | '!=' | '>=' | '<=' });
      i += op.length;
    } else {
      let value = '';
      while (i < input.length && !/[\s()[\],'"!=<>]/.test(input[i])) value += input[i++];
      tokens.push({ type: 'word', value });
    }
  }
  return tokens;
}

/** A bare filter value as Meilisearch reads it: numbers and booleans, otherwise a string. */
function bareValue(word: string): string | number | boolean {
  if (word === 'true') return true;
  if (word === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(word)) return Number(word);
  return word;
}

const isKeyword = (t: Token | undefined, keyword: string) =>
  t?.type === 'word' && t.value.toUpperCase() === keyword;

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Clause {
    const clause = this.or();
    if (this.i < this.tokens.length) throw new UnsupportedSearchRequest('trailing input in filter');
    return clause;
  }

  private peek() {
    return this.tokens[this.i];
  }

  private next() {
    const token = this.tokens[this.i++];
    if (!token) throw new UnsupportedSearchRequest('filter ended early');
    return token;
  }

  private or(): Clause {
    const clauses = [this.and()];
    while (isKeyword(this.peek(), 'OR')) {
      this.i++;
      clauses.push(this.and());
    }
    return clauses.length === 1 ? clauses[0] : { kind: 'or', clauses };
  }

  private and(): Clause {
    const clauses = [this.not()];
    while (isKeyword(this.peek(), 'AND')) {
      this.i++;
      clauses.push(this.not());
    }
    return clauses.length === 1 ? clauses[0] : { kind: 'and', clauses };
  }

  private not(): Clause {
    if (isKeyword(this.peek(), 'NOT')) {
      this.i++;
      return { kind: 'not', clause: this.not() };
    }
    if (this.peek()?.type === '(') {
      this.i++;
      const clause = this.or();
      if (this.next().type !== ')') throw new UnsupportedSearchRequest('unclosed "(" in filter');
      return clause;
    }
    return this.condition();
  }

  private value(): string | number | boolean {
    const token = this.next();
    if (token.type === 'string') return token.value;
    if (token.type === 'word') return bareValue(token.value);
    throw new UnsupportedSearchRequest('expected a value in filter');
  }

  private number(): number {
    const value = this.value();
    const n = typeof value === 'number' ? value : Number(value);
    if (typeof value === 'boolean' || Number.isNaN(n))
      throw new UnsupportedSearchRequest('expected a number in filter');
    return n;
  }

  private list(): (string | number)[] {
    if (this.next().type !== '[') throw new UnsupportedSearchRequest('expected "[" after IN');
    const values: (string | number)[] = [];
    while (this.peek()?.type !== ']') {
      const value = this.value();
      values.push(typeof value === 'boolean' ? String(value) : value);
      if (this.peek()?.type === ',') this.i++;
    }
    this.i++;
    return values;
  }

  private condition(): Clause {
    const head = this.next();
    if (head.type !== 'word' && head.type !== 'string')
      throw new UnsupportedSearchRequest('expected an attribute in filter');
    const field = head.value;
    if (field.startsWith('_')) throw new UnsupportedSearchRequest(`unsupported filter on ${field}`);
    const token = this.peek();

    if (token?.type === 'op') {
      this.i++;
      switch (token.value) {
        case '=':
          return { kind: 'eq', field, value: this.value() };
        case '!=':
          return { kind: 'not', clause: { kind: 'eq', field, value: this.value() } };
        case '>':
          return { kind: 'range', field, gt: this.number() };
        case '>=':
          return { kind: 'range', field, gte: this.number() };
        case '<':
          return { kind: 'range', field, lt: this.number() };
        case '<=':
          return { kind: 'range', field, lte: this.number() };
      }
    }
    if (isKeyword(token, 'IN')) {
      this.i++;
      return { kind: 'in', field, values: this.list() };
    }
    if (isKeyword(token, 'EXISTS')) {
      this.i++;
      return { kind: 'exists', field };
    }
    if (isKeyword(token, 'NOT')) {
      this.i++;
      if (isKeyword(this.peek(), 'IN')) {
        this.i++;
        return { kind: 'not', clause: { kind: 'in', field, values: this.list() } };
      }
      if (isKeyword(this.peek(), 'EXISTS')) {
        this.i++;
        return { kind: 'not', clause: { kind: 'exists', field } };
      }
      throw new UnsupportedSearchRequest(`unsupported filter after "${field} NOT"`);
    }
    // `attr from TO to`
    if (token?.type === 'word' || token?.type === 'string') {
      const from = this.number();
      if (!isKeyword(this.next(), 'TO')) throw new UnsupportedSearchRequest('unsupported filter');
      return { kind: 'range', field, gte: from, lte: this.number() };
    }
    throw new UnsupportedSearchRequest(`unsupported filter on ${field}`);
  }
}

export function parseMeiliFilterExpression(expression: string): Clause | null {
  const tokens = tokenize(expression);
  return tokens.length ? new Parser(tokens).parse() : null;
}

/**
 * A Meilisearch `filter` parameter: a string, or an array whose elements are ANDed, each element a
 * string or an array of strings that are ORed.
 */
export function parseMeiliFilter(filter: string | (string | string[])[] | undefined): Clause[] {
  if (filter === undefined) return [];
  const parts = typeof filter === 'string' ? [filter] : filter;
  const clauses: Clause[] = [];
  for (const part of parts) {
    if (Array.isArray(part)) {
      const alternatives = part
        .map(parseMeiliFilterExpression)
        .filter((c): c is Clause => c !== null);
      if (alternatives.length) clauses.push({ kind: 'or', clauses: alternatives });
    } else {
      const clause = parseMeiliFilterExpression(part);
      if (clause) clauses.push(clause);
    }
  }
  return clauses;
}
