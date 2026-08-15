import fs from 'node:fs';

/**
 * Bind a test's own client locals to the canonical mock nodes.
 *
 * Handles the shape the codemod refuses as "hoisted entry is not a bare vi.fn()": a factory
 * whose exports are client-shaped objects of typed spies. Each spy becomes the canonical node
 * at the same path, so `mockDbRead.image.findFirst` keeps working as a name.
 *
 * REFUSES rather than guesses when a leaf carries behaviour that is not a canonical default —
 * deleting one of those is silent, and it cost four tests in get-engaged-models-by-ids.
 *
 *   node .test-perf/bind-locals.mjs <list-file> [--write]
 */
const WRITE = process.argv.includes('--write');
const files = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n');

const ROOTS = {
  '~/server/db/client': { dbRead: 'dbMock.dbRead', dbWrite: 'dbMock.dbWrite' },
  '~/server/redis/client': { redis: 'redisMock.redis', sysRedis: 'redisMock.sysRedis' },
  '~/server/logging/client': { logToAxiom: 'loggingMock.logToAxiom' },
};
const IMPORTS = {
  dbMock: "import { dbMock } from '~/__tests__/mocks/db.mock';",
  redisMock: "import { redisMock } from '~/__tests__/mocks/redis.mock';",
  loggingMock: "import { loggingMock } from '~/__tests__/mocks/logging.mock';",
};
const CONSTANT_KEYS = /^REDIS_(SYS_|SUB_)?KEYS$/;
const DEFAULT_INNER = /^(?:null|\[\]|0|undefined|false|Promise\.resolve\((?:null|\[\]|0)\))$/;

const close = (src, open) => {
  const pair = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (pair[c]) stack.push(pair[c]);
    else if (c === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return i; }
  }
  return -1;
};

// top-level `key: value` pairs of an object literal starting at `open`
function entries(src, open) {
  const end = close(src, open);
  const out = [];
  let depth = 0;
  for (let i = open; i < end; i++) {
    const c = src[i];
    if ('({['.includes(c)) depth++;
    else if (')}]'.includes(c)) depth--;
    else if (depth === 1) {
      const m = /^([A-Za-z_$][\w$]*)\s*:\s*/.exec(src.slice(i));
      if (m && /[{,\s]/.test(src[i - 1] ?? '')) {
        const vs = i + m[0].length;
        let ve;
        if ('({['.includes(src[vs])) ve = close(src, vs) + 1;
        else { ve = vs; while (ve < end && !',\n'.includes(src[ve])) ve++; }
        out.push({ key: m[1], value: src.slice(vs, ve).trim(), start: i, end: ve });
        i = ve;
      }
    }
  }
  return out;
}

const isSpy = (v) => /^vi\.fn\(/.test(v);
function spyIsDefault(v) {
  // `vi.fn().mockResolvedValue(undefined)` is the canonical logToAxiom default spelled long-hand.
  const chained = /^vi\.fn\(\)\.mock(?:ResolvedValue|ReturnValue)\((undefined|null|\[\]|0)?\)$/.exec(v.trim());
  if (chained) return true;
  const inner = v.replace(/^vi\.fn\(/, '').replace(/\)$/, '').trim();
  if (!inner) return true;
  const body = inner.replace(/^(?:async\s*)?\([^)]*\)\s*(?::[^=]*)?=>\s*/, '').trim();
  return DEFAULT_INNER.test(body);
}

let ok = 0, refused = 0;
for (const file of files) {
  let src = fs.readFileSync(file, 'utf8');
  const bindings = [];
  const needImports = new Set();
  const cuts = [];
  const drift = [];
  const preserve = [];
  const hoistedExports = new Set(
    [...src.matchAll(/const \{([^}]*)\} = vi\.hoisted\(/g)]
      .flatMap((m) => m[1].split(',').map((s) => s.trim()))
      .filter(Boolean)
  );
  let bad = null;

  for (const [spec, roots] of Object.entries(ROOTS)) {
    const at = src.indexOf(`vi.mock('${spec}'`);
    if (at === -1) continue;
    const callOpen = src.indexOf('(', at);
    const callEnd = close(src, callOpen);
    const objOpen = src.indexOf('{', src.indexOf('=>', callOpen));
    if (objOpen === -1 || objOpen > callEnd) { bad = `${spec}: factory is not an object literal`; break; }

    for (const e of entries(src, objOpen)) {
      if (CONSTANT_KEYS.test(e.key)) { drift.push(`${spec}.${e.key}`); continue; }
      const target = roots[e.key];
      if (!target) { bad = `${spec}: factory declares "${e.key}", which the canonical mock does not own`; break; }
      needImports.add(target.split('.')[0]);

      if (/^[A-Za-z_$][\w$]*$/.test(e.value)) {
        bindings.push([e.value, target]);
      } else if (e.value.startsWith('{')) {
        // an inline client literal: bind each leaf spy at its path
        const walk = (open, path) => {
          for (const leaf of entries(src, open)) {
            if (isSpy(leaf.value)) {
              if (!spyIsDefault(leaf.value)) { bad = `${spec}.${[...path, leaf.key].join('.')} carries behaviour`; return; }
            } else if (/^[A-Za-z_$][\w$]*$/.test(leaf.value)) {
              bindings.push([leaf.value, `${target}.${[...path, leaf.key].join('.')}`]);
            } else if (leaf.value.startsWith('{')) {
              walk(src.indexOf('{', leaf.start + leaf.key.length), [...path, leaf.key]);
            } else {
              bad = `${spec}.${[...path, leaf.key].join('.')} is not a spy, a local or an object`;
              return;
            }
          }
        };
        walk(src.indexOf('{', e.start + e.key.length), []);
        if (bad) break;
      } else if (isSpy(e.value)) {
        if (!spyIsDefault(e.value)) { bad = `${spec}.${e.key} carries behaviour`; break; }
      } else {
        bad = `${spec}.${e.key} is neither a local nor a literal`;
        break;
      }
    }
    if (bad) break;
    cuts.push([at, callEnd + (src[callEnd + 1] === ';' ? 2 : 1)]);
  }

  if (bad) { console.log('REFUSED', file.replace('src/server/services/__tests__/', '').padEnd(52), bad); refused++; continue; }
  if (!cuts.length) { console.log('SKIP   ', file.replace('src/server/services/__tests__/', ''), 'no canonical vi.mock'); continue; }

  // every local we bind must have a behaviour-free declaration, which we then remove
  const removals = [];
  for (const [local] of bindings) {
    // `mockX: { … }` / `mockX: vi.fn(…)` in a hoisted object, or a module-scope const of either.
    const hoisted = new RegExp(`\\n\\s*${local}:\\s*(?:vi\\.fn)?[{(]`).exec(src);
    const constDecl = new RegExp(`\\n(?:const|let)\\s+${local}(?::[^=]+)?\\s*=\\s*(?:vi\\.fn)?[{(]`).exec(src);
    const hit = hoisted ?? constDecl;
    if (!hit) { bad = `no declaration found for ${local}`; break; }
    const braceAt = hit.index + hit[0].length - 1;
    let end = close(src, braceAt);
    // a chained `.mockResolvedValue(…)` belongs to the declaration too
    const chain = /^\.mock\w+\(/.exec(src.slice(end + 1));
    if (chain) end = close(src, end + chain[0].length);
    if (end === -1) { bad = `unbalanced declaration for ${local}`; break; }
    // Balanced extraction: a lazy `[^;]*?` stops inside an arrow body's own parens and hands
    // spyIsDefault a truncated call, which then reads as a bare default. That is how
    // `vi.fn(async (cb) => cb(tx))` slipped through as behaviour-free.
    const decl = src.slice(hit.index, end + 1);

    // 🔴 A leaf that is a bare IDENTIFIER declared elsewhere is a refusal, not a clear. The
    // client literal is the only thing wiring such a spy to the module; delete the literal and
    // the spy stays alive, still armed by `beforeEach`, connected to nothing — and the code
    // under test silently reads the canonical default instead. Behaviour-free is not the same
    // as safe to delete. (Cost 2 tests in minor-hash.service.test.ts, caught by a run and not
    // by this check, which only asked whether the leaves carried behaviour.)
    for (const m of decl.matchAll(/([\w$]+)\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/g)) {
      const [, key, ident] = m;
      if (/^(vi|undefined|null|true|false)$/.test(ident)) continue;
      if (new RegExp(`(?:const|let)\\s+${ident}\\b`).test(src) || src.includes(`${ident}:`)) {
        bad = `${local}.${key} is the identifier "${ident}", declared elsewhere — bind it to the canonical node by hand`;
        break;
      }
    }
    if (bad) break;
    // Behaviour is PRESERVED, not dropped: each non-default spy becomes an explicit call on the
    // canonical node at the same path. Refuse only when the body names something that will not
    // exist at module scope after the factory is gone.
    const target = bindings.find(([l]) => l === local)[1];
    for (let k = decl.indexOf('vi.fn('); k !== -1; k = decl.indexOf('vi.fn(', k + 1)) {
      const callEnd = close(decl, k + 'vi.fn'.length);
      if (callEnd === -1) continue;
      let full = decl.slice(k, callEnd + 1);
      let stop = callEnd;
      const chained = /^\.mock\w+\(/.exec(decl.slice(callEnd + 1));
      if (chained) { stop = close(decl, callEnd + chained[0].length); full = decl.slice(k, stop + 1); }
      if (spyIsDefault(full)) continue;

      // the property path this spy sits at, read backwards from the call
      const before = decl.slice(0, k);
      const path = [];
      let tail = before;
      for (;;) {
        const m = /([A-Za-z_$][\w$]*)\s*:\s*(?:\{[\s\S]*)?$/.exec(tail);
        if (!m) break;
        path.unshift(m[1]);
        tail = tail.slice(0, m.index);
        const opens = (tail.match(/\{/g) ?? []).length - (tail.match(/\}/g) ?? []).length;
        if (opens <= 1) break;
      }
      if (!path.length || path[0] === local) path.shift();
      if (!path.length) { bad = `${local}: cannot locate the path of ${full.slice(0, 40)}`; break; }

      const free = [...new Set([...full.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((m) => m[1]))]
        .filter((n) => !/^(vi|fn|async|await|return|const|let|new|typeof|unknown|any|void|Promise|null|undefined|true|false|number|string|boolean|mock\w*)$/.test(n));
      const unresolved = free.filter((n) => !new RegExp(`(?:const|let)\\s+${n}\\b|\\b${n}\\s*[,}]`).test(src.slice(0, hit.index)) && !hoistedExports.has(n));
      if (unresolved.length) { bad = `${local}.${path.join('.')} names ${unresolved.join(', ')} which the factory scoped`; break; }

      preserve.push(`${target}.${path.join('.')}${full.slice('vi.fn'.length).replace(/^\(/, '.mockImplementation(').replace(/^\.mockImplementation\(\)/, '')};`);
    }
    if (bad) break;
    const tail = src.slice(end + 1).match(/^[,;]?\n/)?.[0] ?? '';
    removals.push([hit.index + 1, end + 1 + tail.length]);
  }
  if (bad) { console.log('REFUSED', file.replace('src/server/services/__tests__/', '').padEnd(52), bad); refused++; continue; }

  for (const [a, b] of [...cuts, ...removals].sort((x, y) => y[0] - x[0])) src = src.slice(0, a) + src.slice(b);
  // an emptied destructuring is dropped; a partly-emptied one keeps its remaining names
  for (const [local] of bindings) src = src.replace(new RegExp(`(const \\{[^}]*?)\\b${local}\\b,?\\s*`), '$1');
  // An emptied destructuring leaves `const { } = vi.hoisted(…)`, which is valid and useless.
  // Remove the whole call, whatever its body shape.
  for (;;) {
    const m = /const \{\s*,?\s*\} = vi\.hoisted\(/.exec(src);
    if (!m) break;
    const end = close(src, m.index + m[0].length - 1);
    if (end === -1) break;
    const tail = src.slice(end + 1).match(/^;?\n/)?.[0] ?? '';
    src = src.slice(0, m.index) + src.slice(end + 1 + tail.length);
  }

  const header =
    [...needImports].map((n) => IMPORTS[n]).join('\n') + '\n' +
    bindings.map(([l, t]) => `const ${l} = ${t};`).join('\n') + '\n' +
    (preserve.length ? preserve.join('\n') + '\n' : '');
  const anchors = [...src.matchAll(/^(?:import [^\n]*;|\} from '[^']*';)\n/gm)];
  const last = anchors.pop();
  if (!last) { console.log('REFUSED', file, 'no import anchor'); refused++; continue; }
  src = src.slice(0, last.index + last[0].length) + header + src.slice(last.index + last[0].length);

  if (/vi\.mock\('~\/server\/(db|redis|logging)\/client'/.test(src)) {
    console.log('REFUSED', file.replace('src/server/services/__tests__/', ''), 'a canonical vi.mock survived');
    refused++;
    continue;
  }
  if (WRITE) fs.writeFileSync(file, src);
  ok++;
  console.log('ok     ', file.replace('src/server/services/__tests__/', '').padEnd(52), bindings.length, 'bindings', drift.length ? `drift:${drift.join(',')}` : '');
}
console.log(`\n${ok} convertible, ${refused} refused${WRITE ? ' (written)' : ' (dry)'}`);
