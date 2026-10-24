// The stated-age vocabulary: how a minor age can be spelled, and the phrasings that
// turn a number into an age claim.
//
// This is DATA, like the word lists beside it — misspellings people actually type
// (`sevem{teen}`, `fivve`), not matching behaviour. The engine that compiles it into
// regexes is still a separate copy in `src/utils/metadata/audit.ts` and in this
// package's `prompt-audit/index.ts`, which diverge on the enriched/debug branches.
//
// `{teen}` expands to `templateParts.teen`, so `seven{teen}` covers `seventeen`,
// `seventen`, `seventein`, `seventien` and `seventn`.

const agesRaw = [
  { age: 17, matches: ['seven{teen}', 'sevn{teen}', 'sevem{teen}', 'seve{teen}', '7{teen}', '17'] },
  { age: 16, matches: ['six{teen}', 'sicks{teen}', 'sixe{teen}', '6{teen}', '16'] },
  {
    age: 15,
    matches: ['fif{teen}', 'fiv{teen}', 'five{teen}', 'fife{teen}', 'fivve{teen}', '5{teen}', '15'],
  },
  { age: 14, matches: ['four{teen}', 'for{teen}', 'fore{teen}', 'foure{teen}', '4{teen}', '14'] },
  {
    age: 13,
    matches: [
      'thir{teen}',
      '3{teen}',
      'ther{teen}',
      'three{teen}',
      'tree{teen}',
      'thee{teen}',
      'thre{teen}',
      'thri{teen}',
      '3{teen}',
      '13',
    ],
  },
  { age: 12, matches: ['twelve', 'twelv', 'twelf', '2{teen}', 'twel', '12'] },
  { age: 11, matches: ['eleven', 'eleve', 'elevn', '1{teen}', 'elvn', '11'] },
  { age: 10, matches: ['ten', 'tenn', 'tene', '10'] },
  { age: 9, matches: ['nine', 'nien', 'nein', 'niene', '9'] },
  { age: 8, matches: ['eight', 'eigt', 'eigh', '8'] },
  { age: 7, matches: ['seven', 'sevn', 'sevem', 'seve', '7'] },
  { age: 6, matches: ['six', 'sicks', 'sixe', '6'] },
  { age: 5, matches: ['five', 'fiv', 'fife', 'fivve', '5'] },
  { age: 4, matches: ['four', 'fore', 'foure', '4'] },
  { age: 3, matches: ['three', 'thee', 'thre', 'thri', '3'] },
  { age: 2, matches: ['two', '2'] },
  { age: 1, matches: ['one', 'uno', '1'] },
];

export const templateParts = {
  teen: ['teen', 'ten', 'tein', 'tien', 'tn'],
  years: ['y', 'yr', 'yrs', 'years', 'year', 'anos'],
  old: ['o', 'old'],
};

/**
 * `ages` with every `{teen}` expanded, in both joined and spaced forms.
 *
 * 🔴 Expanded HERE, once, producing new arrays. Both consumers used to run this loop
 * themselves and ASSIGN BACK to `age.matches` — harmless while each owned its own copy,
 * but with the table shared that would be two modules mutating one imported object.
 * Consumers read this; nothing writes it.
 */
export const ages = agesRaw.map(({ age, matches }) => {
  const expanded = new Set<string>();
  for (const match of matches) {
    if (!match.includes('{teen}')) {
      expanded.add(match);
      continue;
    }
    const base = match.replace('{teen}', '').trim();
    for (const teen of templateParts.teen) {
      expanded.add(base + teen);
      expanded.add(base + ' ' + teen);
    }
  }
  return { age, matches: Array.from(expanded) };
});

export const templates = [
  'aged {age}',
  'age {age}',
  'age of {age}',
  '{age} age',
  '{age} {years} {old}',
  '{age} {years}',
  '{age}th birthday',
];

/**
 * Canonical English number words. These get a trailing `\b` when compiled, so compound
 * words don't match — "eight" must not match "eighty" via the `{age} {years}` template
 * (the year unit can be a single "y"), nor "seven" match "seventy".
 *
 * The truncated/typo variants in `ages` are deliberately absent, so they skip that
 * boundary and still catch ordinal forms through `{age}th birthday`
 * ("eigh" + "th" -> "eighth birthday").
 */
export const canonicalNumberWords = new Set([
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
]);
