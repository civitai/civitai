# Profanity Filter

Profanity detection system built on Obscenity, with the blocked-word list from
`@civitai/mod-utils/profanity/lists` (`blocked-words.json`), or, with the
`profanity-managed-list` flag on, the moderator-managed `ProfanityWord` list for search and
comment masking in the browser.

## Usage

```typescript
import { createProfanityFilter } from '~/libs/profanity-simple';

// Default settings
const filter = createProfanityFilter();

// Custom replacement style
const filter = createProfanityFilter({
  replacementStyle: 'grawlix', // 'asterisk', 'grawlix', or 'remove'
});

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
  replacementStyle: 'asterisk',
});
```

## Components

Automatically integrated in:

- `BlurText` - Filters text when `blurNsfw` is enabled
- Search queries - Blocks profane searches in green domain
- Model/Article/Bounty creation - Auto-marks as NSFW if profanity detected

## Word Lists and Pattern Matching

### Blocked Words List

- **Location**: `packages/civitai-mod-utils/src/profanity/lists/blocked-words.json`, imported as `@civitai/mod-utils/profanity/lists`
- **Content**: Comprehensive list of inappropriate terms, slurs, and NSFW content
- **Format**: JSON array of strings, supports [obscenity patterns](https://github.com/jo3-l/obscenity/blob/main/docs/guide/patterns.md) like `|word` for word boundaries
- **Processing**: Words are cleaned (regex quantifiers stripped, pipe boundaries preserved), lowercased, deduplicated, sorted, and cached. The cleaning and validity rules live in `@civitai/mod-utils/profanity/word-rules`, shared with the moderator app's entry check.

### Managed blocked list

- **Where moderators edit it**: the `ProfanityWord` tab of the moderator app's Blocklists page (a `Blocklist` row, seeded by hand from `blocked-words.json`; the tab refuses edits until the row exists).
- **Who reads it**: the server only, through `getServerProfanityFilter`, while `profanity-managed-list` is on. The browser never receives it:
  - comment, review and chat responses carry `maskedContent` / `maskedDetails` for other viewers: a string when masking changed the text, `null` when it is clean, absent when it was not computed (the browser then masks with the shipped list). The author's own write response carries none;
  - `/api/search` and the model, article, bounty, comic and image semantic search procedures refuse a profane query themselves (`search_refused`, verdict only, `refuse-profane-search.ts`).;
  - the trainer's trigger-word warning comes from `training.auditTriggerWord`, which answers with a severity only;
  - those searches check every query on civitai.com whatever the flag says (flag off or Flipt unreachable: the browser's own list, the shipped words and the moderators' benign words; a failed check: the shipped list), so the browser leaves those searches to the server (`browserChecksProfanity`). `system.getBenignPhrases` carries no profanity list;
- **When it is not used**: flag off (the browser checks and masks with the shipped list, as before), no row, a row below the floor, a failed read, or a list the filter cannot build all mean the shipped list.

### Whitelist Words List

Three sources feed the whitelist, and they do not combine the same way:

- **`whitelist-words.json`** in `@civitai/mod-utils/profanity/lists` (430 entries) — legitimate words containing a
  profane substring ("analysis" contains "anal"). The static default.
- **`BlocklistType.ProfanityBenignWord`** — the moderator-editable list at `/moderator/blocklists`,
  passed in as `moderatorWhitelist`. It **REPLACES** the JSON file rather than adding to it, so a
  moderator removing a shipped entry really removes it; `null` (no row) falls back to the JSON, `[]`
  is honoured as an empty whitelist. It reaches search, chat and `BlurText` via `useCheckProfanity`.
  `auditPromptEnriched` builds its filter with no moderator list, so the generation and trainer
  gates still see the JSON. **Consequence: the two drift.** The row was seeded verbatim from the JSON
  as it stood on 2026-08-19; every entry added to the JSON since reaches the generation/trainer gates
  only, and reaches search/chat/`BlurText` in an environment with that row only if a moderator also
  adds it there. Adding a benign word is therefore two edits, not one.
- **`LIBRARY_OVERMATCH_TOKENS`** (`src/libs/profanity-simple/index.ts`) — tokens obscenity's own
  dataset matches more broadly than the word they stand for. Always unioned in and not
  moderator-editable, because it corrects an upstream pattern rather than curating a benign word.
  Adding one is a measurement, not a guess: check how many `Tag` rows actually carry the token
  before excusing it. The constant records which tokens, why, and what was rejected.

**Integration**: JSON / moderator entries are mapped onto the profane substrings they contain at
filter init (`createWhitelistMappings`); all three sources land in `whitelistSet`, which both
`analyze()` and `clean()` consult (via `excludeWhitelisted`), so rendered output and moderation
verdicts agree: `RenderHtml` leaves `fukushima` and `futari` intact. Only a match whose full
surrounding word is whitelisted is spared, so `fukushimafuck` is still censored.

### Pattern Generation

- **Obscenity Patterns**: Leverages obscenity's pattern system for phrase matching and leetspeak detection
- **Minimum Length**: `extendWithCustomDataset` drops `blocked-words.json` entries shorter than 3
  characters — measured _with_ pipe boundary markers, so `|ab|` counts as 4 (and today no entry is
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
