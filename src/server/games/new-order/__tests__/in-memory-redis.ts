/**
 * Tiny in-memory store mimicking the Redis subset that `createCounter` and
 * slot-rotation code use. Lets us exercise the actual implementation (not
 * mocks-of-mocks) for race / clamp / cache-miss correctness.
 *
 * Not a complete Redis emulation — just the commands we call. Add more as
 * new tests require them.
 */

type ZSet = Map<string, number>; // member → score
type HSet = Map<string, string>;

export class InMemoryRedis {
  private hashes = new Map<string, HSet>();
  private sortedSets = new Map<string, ZSet>();
  private sets = new Map<string, Set<string>>();
  private strings = new Map<string, string>();
  // TTLs are tracked but not actively enforced (no setTimeout) — tests can
  // assert that `expire` was called by spying on this map.
  public ttls = new Map<string, number>();

  // ---------- Hash ops ----------
  async hSet(key: string, field: string, value: number | string) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    const h = this.hashes.get(key)!;
    const isNew = !h.has(field) ? 1 : 0;
    h.set(field, String(value));
    return isNew;
  }
  async hGet(key: string, field: string) {
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hIncrBy(key: string, field: string, delta: number) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    const h = this.hashes.get(key)!;
    const current = Number(h.get(field) ?? 0);
    const next = current + delta;
    h.set(field, String(next));
    return next;
  }
  async hDel(key: string, fields: string | string[]) {
    const list = Array.isArray(fields) ? fields : [fields];
    const h = this.hashes.get(key);
    if (!h) return 0;
    let removed = 0;
    for (const f of list) if (h.delete(f)) removed++;
    return removed;
  }
  async hmGet(key: string, fields: string[]) {
    const h = this.hashes.get(key);
    return fields.map((f) => h?.get(f) ?? null);
  }
  async hGetAll(key: string) {
    const h = this.hashes.get(key);
    const out: Record<string, string> = {};
    if (h) for (const [k, v] of h) out[k] = v;
    return out;
  }
  async hExpire(_key: string, _field: string, _seconds: number) {
    // No-op: per-field TTL not tracked.
    return 1;
  }

  // ---------- Sorted-set ops ----------
  async zAdd(key: string, entry: { score: number; value: string } | Array<{ score: number; value: string }>) {
    if (!this.sortedSets.has(key)) this.sortedSets.set(key, new Map());
    const z = this.sortedSets.get(key)!;
    const entries = Array.isArray(entry) ? entry : [entry];
    let added = 0;
    for (const e of entries) {
      const isNew = !z.has(e.value);
      z.set(e.value, e.score);
      if (isNew) added++;
    }
    return added;
  }
  async zScore(key: string, member: string) {
    const z = this.sortedSets.get(key);
    const score = z?.get(member);
    return score === undefined ? null : score;
  }
  async zIncrBy(key: string, delta: number, member: string) {
    if (!this.sortedSets.has(key)) this.sortedSets.set(key, new Map());
    const z = this.sortedSets.get(key)!;
    const next = (z.get(member) ?? 0) + delta;
    z.set(member, next);
    return next;
  }
  async zRem(key: string, members: string | string[]) {
    const z = this.sortedSets.get(key);
    if (!z) return 0;
    const list = Array.isArray(members) ? members : [members];
    let removed = 0;
    for (const m of list) if (z.delete(m)) removed++;
    return removed;
  }
  async zRangeWithScores(
    key: string,
    _min: number,
    _max: number,
    opts?: { BY?: string; REV?: boolean; LIMIT?: { offset: number; count: number } }
  ) {
    const z = this.sortedSets.get(key);
    if (!z) return [];
    let entries = Array.from(z.entries()).map(([value, score]) => ({ value, score }));
    if (opts?.REV) entries.sort((a, b) => b.score - a.score);
    else entries.sort((a, b) => a.score - b.score);
    if (opts?.LIMIT) {
      const { offset, count } = opts.LIMIT;
      entries = entries.slice(offset, offset + count);
    }
    return entries;
  }
  async zCard(key: string) {
    return this.sortedSets.get(key)?.size ?? 0;
  }
  async zRemRangeByScore(key: string, _min: string | number, _max: string | number) {
    const z = this.sortedSets.get(key);
    if (!z) return 0;
    const minNum = _min === '-inf' ? -Infinity : Number(_min);
    const maxNum = _max === '+inf' ? Infinity : Number(_max);
    let removed = 0;
    for (const [member, score] of z) {
      if (score >= minNum && score <= maxNum) {
        z.delete(member);
        removed++;
      }
    }
    return removed;
  }

  // ---------- Set ops ----------
  async sAdd(key: string, members: string | string[]) {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    const s = this.sets.get(key)!;
    const list = Array.isArray(members) ? members : [members];
    let added = 0;
    for (const m of list) {
      if (!s.has(m)) {
        s.add(m);
        added++;
      }
    }
    return added;
  }
  async sIsMember(key: string, member: string) {
    return this.sets.get(key)?.has(member) ? 1 : 0;
  }
  async sMembers(key: string) {
    return Array.from(this.sets.get(key) ?? []);
  }
  async sRem(key: string, members: string | string[]) {
    const s = this.sets.get(key);
    if (!s) return 0;
    const list = Array.isArray(members) ? members : [members];
    let removed = 0;
    for (const m of list) if (s.delete(m)) removed++;
    return removed;
  }

  // ---------- String / generic ops ----------
  async get(key: string) {
    return this.strings.get(key) ?? null;
  }
  async set(
    key: string,
    value: string,
    opts?: { NX?: boolean; EX?: number }
  ): Promise<string | null> {
    if (opts?.NX && this.strings.has(key)) return null;
    this.strings.set(key, value);
    if (opts?.EX) this.ttls.set(key, opts.EX);
    return 'OK';
  }
  async del(keys: string | string[]) {
    const list = Array.isArray(keys) ? keys : [keys];
    let removed = 0;
    for (const k of list) {
      if (this.hashes.delete(k)) removed++;
      if (this.sortedSets.delete(k)) removed++;
      if (this.sets.delete(k)) removed++;
      if (this.strings.delete(k)) removed++;
    }
    return removed;
  }
  async unlink(keys: string | string[]) {
    return this.del(keys);
  }
  async expire(key: string, seconds: number) {
    this.ttls.set(key, seconds);
    return 1;
  }
  async incr(key: string) {
    const next = (Number(this.strings.get(key) ?? 0) + 1).toString();
    this.strings.set(key, next);
    return Number(next);
  }
  async decr(key: string) {
    const next = (Number(this.strings.get(key) ?? 0) - 1).toString();
    this.strings.set(key, next);
    return Number(next);
  }

  // Multi/exec — minimal chainable wrapper that returns command results in order.
  multi() {
    const ops: Array<() => Promise<unknown>> = [];
    const chain: any = {};
    chain.setNX = (key: string, value: string) => {
      ops.push(async () => {
        if (this.strings.has(key)) return 0;
        this.strings.set(key, value);
        return 1;
      });
      return chain;
    };
    chain.expire = (key: string, seconds: number) => {
      ops.push(() => this.expire(key, seconds));
      return chain;
    };
    chain.exec = async () => {
      const results: unknown[] = [];
      for (const op of ops) results.push(await op());
      return results;
    };
    return chain;
  }
}
