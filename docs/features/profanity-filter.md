# Profanity Filter

Profanity detection system built on Obscenity, with the blocked-word list from
`~/utils/metadata/lists/blocked-words.json`.

## Usage

```typescript
import { createProfanityFilter } from '~/libs/profanity-simple';

// Default settings
const filter = createProfanityFilter();

// Custom replacement style
const filter = createProfanityFilter({
  replacementStyle: 'grawlix', // 'asterisk', 'grawlix', or 'remove'
});

// Check for profanity
filter.isProfane('some text');

// Clean text
filter.clean('bad words');

// Detailed analysis
const analysis = filter.analyze('text');
// { isProfane: boolean, matchCount: number, matches: string[], matchedWords: string[] }
// `matches` = the DATASET words that matched. `matchedWords` = the full words the INPUT
// carried. They differ on substrings and near-spellings — "fagus" matches the dataset's
// "fag" — so anything user-facing must report `matchedWords`.
```

## React Hook

```typescript
import { useCheckProfanity } from '~/hooks/useCheckProfanity';

const { hasProfanity, matches, cleanedText } = useCheckProfanity(text, {
  enabled: true,
  replacementStyle: 'asterisk'
});
```

## Components

Automatically integrated in:
- `BlurText` - Filters text when `blurNsfw` is enabled
- Search queries - Blocks profane searches in green domain
- Model/Article/Bounty creation - Auto-marks as NSFW if profanity detected

## Word Lists and Pattern Matching

### Blocked Words List
- **Location**: `~/utils/metadata/lists/blocked-words.json`
- **Content**: Comprehensive list of inappropriate terms, slurs, and NSFW content
- **Format**: JSON array of strings, supports [obscenity patterns](https://github.com/jo3-l/obscenity/blob/main/docs/guide/patterns.md) like `|word` for word boundaries
- **Processing**: Words are cleaned (regex quantifiers stripped, pipe boundaries preserved), lowercased, deduplicated, sorted, and cached.

### Whitelist Words List

Three sources feed the whitelist, and they do not combine the same way:

- **`~/utils/metadata/lists/whitelist-words.json`** (424 entries) — legitimate words containing a
  profane substring ("analysis" contains "anal"). The static default.
- **`BlocklistType.ProfanityBenignWord`** — the moderator-editable list at `/moderator/blocklists`,
  passed in as `moderatorWhitelist`. It **REPLACES** the JSON file rather than adding to it, so a
  moderator removing a shipped entry really removes it; `null` (no row) falls back to the JSON, `[]`
  is honoured as an empty whitelist. It reaches search, chat and `BlurText` via `useCheckProfanity`.
  `auditPromptEnriched` builds its filter with no moderator list, so the generation and trainer
  gates still see the JSON.
- **`LIBRARY_OVERMATCH_TOKENS`** (`src/libs/profanity-simple/index.ts`) — tokens obscenity's own
  dataset matches more broadly than the word they stand for. Always unioned in and not
  moderator-editable, because it corrects an upstream pattern rather than curating a benign word.
  Adding one is a measurement, not a guess: check how many `Tag` rows actually carry the token
  before excusing it. The constant records which tokens, why, and what was rejected.

**Integration**: JSON / moderator entries are mapped onto the profane substrings they contain at
filter init (`createWhitelistMappings`); all three sources land in `whitelistSet`, which **only
`analyze()` consults**. `clean()` censors the matcher's raw matches with no whitelist at all, so
`RenderHtml` still asterisks shipped whitelist entries such as `fukushima` and `futari`.

### Pattern Generation
- **Obscenity Patterns**: Leverages obscenity's pattern system for phrase matching and leetspeak detection
- **Minimum Length**: `extendWithCustomDataset` drops `blocked-words.json` entries shorter than 3
  characters — measured *with* pipe boundary markers, so `|ab|` counts as 4 (and today no entry is
  short enough for this to fire). It does **not** bound obscenity's built-in `englishDataset`, which
  is added wholesale and does carry 2-character patterns. Short-token false positives therefore come
  from upstream and are handled by `LIBRARY_OVERMATCH_TOKENS`, not here.
- **Caching**: Processed word lists are cached for performance

### How It Works
1. **Initialization**: `blocked-words.json` is cleaned and deduplicated, then added to obscenity's English dataset as patterns
2. **Whitelist Mapping**: Legitimate words containing profane substrings are automatically whitelisted
3. **Pattern Matching**: Obscenity creates regex patterns that handle leetspeak and variations

## Implementation

- **Obscenity**: Core detection with leetspeak handling and advanced pattern matching
- **Metadata**: Uses existing NSFW word lists with intelligent whitelist support
- **Synchronous**: Works directly in React components without async dependencies
