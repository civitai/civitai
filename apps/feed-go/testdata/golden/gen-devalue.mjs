// Node's own devalue output for values that exercise every rule of the writer: string escapes,
// number formatting, the special indexes, Dates, primitive dedup, shared objects and arrays (and
// empty ones), JS key order, Map / Set / BigInt, and JSON.parse'd values. Writes
// devalue/special.json: per case its name, `devalue.stringify(value)` and the tRPC body. The Go test
// (internal/devalue/golden_test.go) builds the same values by name and requires the same bytes.
//
//   node apps/feed-go/testdata/golden/gen-devalue.mjs     (devalue from the repo's node_modules, or
//                                                           GOLDEN_NODE_MODULES)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDep } from './pack.mjs';
import { devalueBody } from './devalue-body.mjs';

const devalue = await importDep('devalue');
const HERE = dirname(fileURLToPath(import.meta.url));

const d = new Date('2026-06-12T10:00:00.123Z');
const user = { id: 1, name: 'shared' };
const arr = [1, 2];
const emptyObj = {};
const emptyArr = [];

const CASES = {
  'strings-escapes': [
    'plain',
    'quote"',
    'back\\slash',
    '</script><script>',
    '>&',
    '\b\f\n\r\t',
    '\u0000\u0001\u000b\u001f',
    '\u007f',
    '\u2028\u2029',
    '\u00e9\u6f22\u5b57',
    '\u{1f600}',
    '',
  ],
  'string-dedup': ['a', 'b', 'a', 'a', 'b'],
  numbers: [
    0, 1, -1, 1.5, 0.1, 1e21, 1e-7, 123456789012345680000, 9007199254740993, 5e-324,
    1.7976931348623157e308, 0.000001, 1e300, -2.5e-8, 4294967295, -123456.789,
  ],
  'number-specials': [NaN, Infinity, -Infinity, -0, 0],
  'number-dedup': [1, 1, 2, 1, 2.5, 2.5],
  'bools-null': [true, false, null, true, null, false],
  'undefined-members': { a: undefined, b: 1, c: [undefined, 2, undefined] },
  'root-undefined': undefined,
  'root-nan': NaN,
  'root-negative-zero': -0,
  'root-infinity': Infinity,
  'root-negative-infinity': -Infinity,
  'root-string': 'x',
  'root-number': 42,
  'root-null': null,
  'root-empty-array': [],
  'root-empty-object': {},
  dates: {
    a: d,
    b: d,
    c: new Date(d.getTime()),
    epoch: new Date(0),
    before: new Date('1969-12-31T23:59:59.999Z'),
    far: new Date('+010000-01-01T00:00:00.000Z'),
    bc: new Date('-000001-06-01T00:00:00.000Z'),
  },
  'shared-objects': [{ u: user }, { u: user }, { u: { id: 1, name: 'shared' } }, user],
  'shared-arrays': { a: arr, b: arr, c: [1, 2] },
  'empty-shared': { a: emptyObj, b: emptyObj, c: {}, d: emptyArr, e: emptyArr, f: [] },
  'key-order': {
    b: 1,
    2: 'x',
    1: 'y',
    a: 2,
    10: 3,
    '01': 4,
    '-1': 5,
    4294967295: 6,
    4294967294: 7,
  },
  'key-escapes': { 'a"b': 1, '<k>': 2, '\u2028': 3, '': 4, 'a\\b': 5 },
  'map-set-bigint': {
    m: new Map([
      ['k', 1],
      [2, 'v'],
      [user, user],
    ]),
    s: new Set([1, 'a', user]),
    big: 123n,
    big2: 123n,
    neg: -5n,
  },
  nested: { a: { b: { c: [{ d: 'x' }, [[]], { e: [null] }] } } },
  'json-parse': JSON.parse(
    '{"b":1,"a":[1,{"c":null,"d":"\\u003c\\u2028"}],"2":true,"x":1e400,"dup":1,"y":-0,"dup":2,"e":{},"f":[]}'
  ),
};

const out = Object.entries(CASES).map(([name, value]) => ({
  name,
  text: devalue.stringify(value),
  body: devalueBody(value),
}));
mkdirSync(join(HERE, 'devalue'), { recursive: true });
writeFileSync(join(HERE, 'devalue', 'special.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`devalue/special.json: ${out.length} cases`);
