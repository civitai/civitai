# Setup Mention Highlighter Command

Sets up VS Code mention highlighting configuration for markdown files. Creates or updates the necessary VS Code workspace files to highlight @dev, @ai, and other @ mentions.

## Recommended Workflow

### 1. **Check to make sure highlighting is setup**:
```
.vscode/
├── extensions.json (created/updated)
└── settings.json (created/updated)
```

`.vscode/extensions.json` should recommend this extension:
```json
{
  "recommendations": [
    "fabiospampinato.vscode-highlight"
  ]
}
```

**Base Configuration**
- `@dev:` - Color: #50FA7B (green), Background: rgba(80, 250, 123, 0.15)
- `@dev:*` - Color: #50FA7B (green), Background: rgba(255, 235, 59, 0.3) with yellow border (new/unprocessed)
- `@ai:` - Color: #C678DD (purple), Background: rgba(198, 120, 221, 0.15)
- `@ai:*` - Color: #C678DD (purple), Background: rgba(255, 235, 59, 0.3) with yellow border (new/unprocessed)

`.vscode/settings.json` should have these mention highlights:
```json
{
  "files.associations": {
    "*.md": "markdown"
  },
  "highlight.regexes": {
    "(^|\\s)(@dev\\s*[:-]\\s*\\*)(.*)$": {
      "filterFileRegex": ".*\\.(md|markdown|mdx)$",
      "decorations": [
        {},
        {
          "backgroundColor": "rgba(255, 235, 59, 0.3)",
          "color": "#50FA7B",
          "fontWeight": "bold",
          "borderRadius": "3px",
          "border": "1px solid rgba(255, 235, 59, 0.8)"
        },
        {
          "color": "#50FA7B"
        }
      ]
    },
    "(^|\\s)(@dev\\s*[:-]\\s*)(.*)$": {
      "filterFileRegex": ".*\\.(md|markdown|mdx)$",
      "decorations": [
        {},
        {
          "backgroundColor": "rgba(80, 250, 123, 0.15)",
          "color": "#50FA7B",
          "fontWeight": "bold"
        },
        {
          "color": "#50FA7B"
        }
      ]
    },
    "(^|\\s)(@ai\\s*[:-]\\s*\\*)(.*)$": {
      "filterFileRegex": ".*\\.(md|markdown|mdx)$",
      "decorations": [
        {},
        {
          "backgroundColor": "rgba(255, 235, 59, 0.3)",
          "color": "#C678DD",
          "fontWeight": "bold",
          "borderRadius": "3px",
          "border": "1px solid rgba(255, 235, 59, 0.8)"
        },
        {
          "color": "#C678DD"
        }
      ]
    },
    "(^|\\s)(@ai\\s*[:-]\\s*)(.*)$": {
      "filterFileRegex": ".*\\.(md|markdown|mdx)$",
      "decorations": [
        {},
        {
          "backgroundColor": "rgba(198, 120, 221, 0.15)",
          "color": "#C678DD",
          "fontWeight": "bold"
        },
        {
          "color": "#C678DD"
        }
      ]
    }
  },
  "highlight.maxMatches": 250,
  "highlight.decorations": {
    "rangeBehavior": 1
  },
  "highlight.regexFlags": "gm"
}
```

### 2. Add mention block if requested (Optional)

If there is a name and color provided below, add a mention block for it to `highlight.regexes`:
$ARGUMENTS

**Example**:
`bob red`:
```json
"(^|\\s)(@bob\\s*[:-]\\s*\\*)(.*)$": {
    "filterFileRegex": ".*\\.(md|markdown|mdx)$",
    "decorations": [
    {},
    {
        "backgroundColor": "rgba(255, 235, 59, 0.3)",
        "color": "#FF6B6B",
        "fontWeight": "bold",
        "borderRadius": "3px",
        "border": "1px solid rgba(255, 235, 59, 0.8)"
    },
    {
        "color": "#FF6B6B"
    }
    ]
},
"(^|\\s)(@bob\\s*[:-]\\s*)(.*)$": {
    "filterFileRegex": ".*\\.(md|markdown|mdx)$",
    "decorations": [
    {},
    {
        "backgroundColor": "rgba(255, 107, 107, 0.15)",
        "color": "#FF6B6B",
        "fontWeight": "bold"
    },
    {
        "color": "#FF6B6B"
    }
    ]
}
```

If a color isn't provided, create one or pick from the list:
- #FF6B6B (coral red)
- #4ECDC4 (teal)
- #45B7D1 (sky blue)
- #96CEB4 (mint green)
- #FFEAA7 (soft yellow)
- #DDA0DD (plum)
- #98D8C8 (seafoam)
- #F7DC6F (golden yellow)
- #BB8FCE (light purple)
- #85C1E9 (powder blue)


### Notes
- DON'T REUSE COLORS - unless explicitly requested in $ARGUMENTS
- Patterns are designed to work specifically with markdown files (*.md, *.markdown, *.mdx)
- The highlight extension must be installed for the highlighting to work
- New mention patterns preserve existing configurations
- Cross-platform compatible (handles both Windows and Unix paths)
- Each user gets two patterns:
  - Regular pattern: `(^|\\s)(@username\\s*[:-]\\s*)(.*)$` for processed comments (handles spaces and both : and - separators)
  - Asterisk pattern: `(^|\\s)(@username\\s*[:-]\\s*\\*)(.*)$` for new/unprocessed comments with yellow indicator
- Asterisk patterns should come before regular patterns in the config
- Supports up to 250 matches per file (configurable)
