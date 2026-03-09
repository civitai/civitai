// Meilisearch filter string → BitDex FilterClause translator

// --- Types ---

export type Value = { Integer: number } | { Bool: boolean } | { String: string };

export type FilterClause =
  | { Eq: [string, Value] }
  | { NotEq: [string, Value] }
  | { Gt: [string, Value] }
  | { Gte: [string, Value] }
  | { Lt: [string, Value] }
  | { Lte: [string, Value] }
  | { In: [string, Value[]] }
  | { NotIn: [string, Value[]] }
  | { And: FilterClause[] }
  | { Or: FilterClause[] }
  | { Not: FilterClause };

export type SortClause = { field: string; direction: 'Asc' | 'Desc' };

// --- Tokenizer ---

type Token =
  | { type: 'word'; value: string }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'lbracket' }
  | { type: 'rbracket' }
  | { type: 'comma' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
    } else if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i++;
    } else if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i++;
    } else if (ch === '[') {
      tokens.push({ type: 'lbracket' });
      i++;
    } else if (ch === ']') {
      tokens.push({ type: 'rbracket' });
      i++;
    } else if (ch === ',') {
      tokens.push({ type: 'comma' });
      i++;
    } else if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      let str = '';
      while (i < input.length && input[i] !== quote) {
        str += input[i];
        i++;
      }
      i++; // closing quote
      tokens.push({ type: 'string', value: str });
    } else if (ch === '-' || ch === '+' || (ch >= '0' && ch <= '9')) {
      // Check if this is a negative number or just a minus
      // A minus is a number start only if followed by a digit
      if (ch === '-' || ch === '+') {
        if (i + 1 < input.length && input[i + 1] >= '0' && input[i + 1] <= '9') {
          let num = ch;
          i++;
          while (i < input.length && input[i] >= '0' && input[i] <= '9') {
            num += input[i];
            i++;
          }
          tokens.push({ type: 'number', value: Number(num) });
        } else {
          // Treat as word
          let word = '';
          while (i < input.length && !' \t\n\r()[],"\''.includes(input[i])) {
            word += input[i];
            i++;
          }
          tokens.push({ type: 'word', value: word });
        }
      } else {
        let num = '';
        while (i < input.length && input[i] >= '0' && input[i] <= '9') {
          num += input[i];
          i++;
        }
        tokens.push({ type: 'number', value: Number(num) });
      }
    } else {
      // Word (field names, keywords like AND/OR/NOT/IN/EXISTS/IS/NULL/true/false)
      let word = '';
      while (i < input.length && !' \t\n\r()[],"\''.includes(input[i])) {
        word += input[i];
        i++;
      }
      tokens.push({ type: 'word', value: word });
    }
  }
  return tokens;
}

// --- Parser ---

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: string): Token {
    const tok = this.advance();
    if (!tok || tok.type !== type) {
      throw new Error(`Expected ${type}, got ${tok?.type ?? 'EOF'}`);
    }
    return tok;
  }

  private isWord(value: string): boolean {
    const tok = this.peek();
    return tok?.type === 'word' && tok.value.toUpperCase() === value.toUpperCase();
  }

  // Parse top-level: OR-separated expressions
  parseExpr(): FilterClause | null {
    return this.parseOr();
  }

  private parseOr(): FilterClause | null {
    const left = this.parseAnd();

    const parts: FilterClause[] = [];
    if (left) parts.push(left);
    while (this.isWord('OR')) {
      this.advance();
      const right = this.parseAnd();
      if (right) parts.push(right);
    }

    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    return { Or: parts };
  }

  private parseAnd(): FilterClause | null {
    const left = this.parseUnary();

    const parts: FilterClause[] = [];
    if (left) parts.push(left);
    while (this.isWord('AND')) {
      this.advance();
      const right = this.parseUnary();
      if (right) parts.push(right);
    }

    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    return { And: parts };
  }

  private parseUnary(): FilterClause | null {
    if (this.isWord('NOT')) {
      this.advance();
      // NOT (expr) or NOT field OP value
      const inner = this.parseUnary();
      if (!inner) return null;
      return { Not: inner };
    }
    return this.parseAtom();
  }

  private parseAtom(): FilterClause | null {
    const tok = this.peek();
    if (!tok) return null;

    // Parenthesized group
    if (tok.type === 'lparen') {
      this.advance();
      const expr = this.parseOr();
      this.expect('rparen');
      return expr;
    }

    // Must be a field name (word or quoted string)
    if (tok.type !== 'word' && tok.type !== 'string') {
      return null;
    }

    const fieldRaw = (tok as { value: string }).value;
    this.advance();

    const field = normalizeFieldName(fieldRaw);

    // Skip fields BitDex doesn't index — consume the rest of the expression
    if (IGNORED_FIELDS.has(field)) {
      this.skipAtomRemainder();
      return null;
    }

    // Check for NOT EXISTS / IS NULL / IS EMPTY
    if (this.isWord('NOT')) {
      const saved = this.pos;
      this.advance();
      if (this.isWord('EXISTS')) {
        this.advance();
        return null; // skip — BitDex doesn't have nulls
      }
      if (this.isWord('IN')) {
        this.advance();
        // field NOT IN [...]
        const values = this.parseValueList();
        return { NotIn: [field, values] };
      }
      // Restore if we consumed NOT but it wasn't EXISTS or IN
      this.pos = saved;
    }

    if (this.isWord('IS')) {
      this.advance();
      if (this.isWord('NULL') || this.isWord('EMPTY')) {
        this.advance();
        return null; // skip — BitDex doesn't have nulls
      }
      throw new Error(`Unexpected token after IS`);
    }

    if (this.isWord('IN')) {
      this.advance();
      const values = this.parseValueList();
      return { In: [field, values] };
    }

    // Comparison operators
    const op = this.peek();
    if (op?.type === 'word') {
      const opVal = op.value;
      if (opVal === '=' || opVal === '!=' || opVal === '>' || opVal === '>=' || opVal === '<' || opVal === '<=') {
        this.advance();
        const value = this.parseValue();
        switch (opVal) {
          case '=': return { Eq: [field, value] };
          case '!=': return { NotEq: [field, value] };
          case '>': return { Gt: [field, value] };
          case '>=': return { Gte: [field, value] };
          case '<': return { Lt: [field, value] };
          case '<=': return { Lte: [field, value] };
        }
      }
      if (opVal === 'IN') {
        this.advance();
        const values = this.parseValueList();
        return { In: [field, values] };
      }
      if (opVal === 'NOT') {
        this.advance();
        if (this.isWord('IN')) {
          this.advance();
          const values = this.parseValueList();
          return { NotIn: [field, values] };
        }
        if (this.isWord('EXISTS')) {
          this.advance();
          return null;
        }
        throw new Error(`Unexpected token after NOT: ${this.peek()?.type}`);
      }
    }

    // Operators that are tokenized as separate characters (=, !=, >, >=, <, <=)
    // These might be split across multiple tokens if tokenizer treats = as part of a word boundary
    // Let's handle them here as well — they could be separate tokens or within words
    // Actually our tokenizer puts them into words. Let me re-check.
    // The tokenizer groups non-space, non-bracket, non-quote chars into words,
    // so "=" would be its own word token. ">=" likewise. This should work.

    throw new Error(`Unexpected token after field "${field}": ${JSON.stringify(this.peek())}`);
  }

  // Consume tokens for an ignored field's operator + value(s)
  private skipAtomRemainder(): void {
    while (this.peek()) {
      const tok = this.peek()!;
      // Stop at expression boundaries
      if (tok.type === 'rparen') break;
      if (tok.type === 'word' && (tok.value.toUpperCase() === 'AND' || tok.value.toUpperCase() === 'OR')) break;
      // Consume bracket groups entirely
      if (tok.type === 'lbracket') {
        this.advance();
        while (this.peek() && this.peek()!.type !== 'rbracket') this.advance();
        if (this.peek()?.type === 'rbracket') this.advance();
        return;
      }
      this.advance();
      // After consuming operator + single value, we're done
      if (tok.type === 'number' || tok.type === 'string' ||
          (tok.type === 'word' && (tok.value === 'true' || tok.value === 'false' || tok.value === 'EXISTS' || tok.value === 'NULL'))) {
        return;
      }
    }
  }

  private parseValueList(): Value[] {
    this.expect('lbracket');
    const values: Value[] = [];
    while (this.peek()?.type !== 'rbracket') {
      if (values.length > 0) {
        // comma is optional in some Meilisearch filter syntax
        if (this.peek()?.type === 'comma') this.advance();
      }
      values.push(this.parseValue());
    }
    this.expect('rbracket');
    return values;
  }

  private parseValue(): Value {
    const tok = this.advance();
    if (tok.type === 'number') {
      return { Integer: tok.value };
    }
    if (tok.type === 'string') {
      return { String: tok.value };
    }
    if (tok.type === 'word') {
      if (tok.value === 'true') return { Bool: true };
      if (tok.value === 'false') return { Bool: false };
      // Could be an unquoted string value (like enum names: image, video, etc.)
      const asNum = Number(tok.value);
      if (!isNaN(asNum) && tok.value !== '') return { Integer: asNum };
      return { String: tok.value };
    }
    throw new Error(`Unexpected value token: ${tok.type}`);
  }
}

// Fields that BitDex doesn't index — silently dropped from translated filters
const IGNORED_FIELDS = new Set(['promptNsfw']);

// Fields remapped to different BitDex field names
const FIELD_REMAP: Record<string, string> = {
  combinedNsfwLevel: 'nsfwLevel',
};

function normalizeFieldName(name: string): string {
  // Strip surrounding quotes
  if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
    name = name.slice(1, -1);
  }
  // Dotted fields: take last segment (e.g., "flags.promptNsfw" → "promptNsfw")
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx !== -1) {
    name = name.substring(dotIdx + 1);
  }
  // Remap fields (e.g., combinedNsfwLevel → nsfwLevel)
  if (FIELD_REMAP[name]) {
    name = FIELD_REMAP[name];
  }
  return name;
}

// --- Public API ---

/**
 * Parse a Meilisearch filter string (or array of strings AND-joined) into BitDex FilterClauses.
 * Returns an array of clauses (implicitly AND-combined at top level).
 */
export function translateFilters(meiliFilter: string | string[]): FilterClause[] {
  const filterStr = Array.isArray(meiliFilter) ? meiliFilter.join(' AND ') : meiliFilter;

  if (!filterStr.trim()) return [];

  const tokens = tokenize(filterStr);
  const parser = new Parser(tokens);
  const expr = parser.parseExpr();

  if (!expr) return [];

  // Flatten top-level AND into array
  if ('And' in expr) return expr.And;
  return [expr];
}

/**
 * Parse a Meilisearch sort string into a BitDex SortClause.
 * Input: "fieldName:asc" or "fieldName:desc"
 */
export function translateSort(meiliSort: string): SortClause | undefined {
  if (!meiliSort?.trim()) return undefined;

  const parts = meiliSort.trim().split(':');
  if (parts.length !== 2) return undefined;

  const field = parts[0];
  const dir = parts[1].toLowerCase();

  if (dir !== 'asc' && dir !== 'desc') return undefined;

  return {
    field,
    direction: dir === 'asc' ? 'Asc' : 'Desc',
  };
}
