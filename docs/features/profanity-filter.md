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

## Implementation

- **Obscenity**: Core detection with leetspeak handling
- **Compromise**: Generates word variations (plurals, conjugations)
- **Metadata**: Uses existing NSFW word lists with whitelist support
- **Synchronous**: Works directly in React components