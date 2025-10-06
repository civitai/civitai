# Profanity Filter

Profanity detection system using Obscenity for core detection and Compromise for word variations.

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
// { isProfane: boolean, matchCount: number, matches: string[] }
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
- **Processing**: Words are cleaned, normalized, and expanded with variations

### Whitelist Words List
- **Location**: `~/utils/metadata/lists/whitelist-words.json`
- **Content**: Legitimate words that contain profane substrings (e.g., "analysis" contains "anal")
- **Purpose**: Prevents false positives by whitelisting common words
- **Integration**: Automatically mapped to profane substrings during filter initialization

### Pattern Generation
- **Word Variations**: Uses Compromise NLP to generate plurals, verb conjugations, and other forms
- **Obscenity Patterns**: Leverages obscenity's pattern system for phrase matching and leetspeak detection
- **Minimum Length**: Filters out words shorter than 3 characters to prevent false matches
- **Caching**: Processed word lists are cached for performance

### How It Works
1. **Initialization**: Blocked words are processed and expanded with linguistic variations
2. **Whitelist Mapping**: Legitimate words containing profane substrings are automatically whitelisted
3. **Pattern Matching**: Obscenity creates regex patterns that handle leetspeak and variations

## Implementation

- **Obscenity**: Core detection with leetspeak handling and advanced pattern matching
- **Compromise**: Generates word variations (plurals, conjugations, verb forms)
- **Metadata**: Uses existing NSFW word lists with intelligent whitelist support
- **Synchronous**: Works directly in React components without async dependencies
