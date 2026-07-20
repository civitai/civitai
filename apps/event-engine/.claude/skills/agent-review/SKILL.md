---
name: agent-review
description: Get external agent review and feedback. Routes Anthropic models through Claude Agent SDK (uses local subscription) and other models through OpenRouter API. Use for code review, architecture feedback, or any external consultation.
---

# Agent Review

Get feedback from an external AI agent. Useful for code review, architecture decisions, or getting a second opinion.

## Running Commands

```bash
echo "code or prompt" | node .claude/skills/agent-review/query.mjs [options] "Your question"
# or
node .claude/skills/agent-review/query.mjs --file <path> [options] "Your question"
```

### Options

| Flag | Short | Description |
|------|-------|-------------|
| `--model <model>` | `-m` | Model or alias (default: gemini) |
| `--file <path>` | `-f` | Read input from file instead of stdin |
| `--lines <start-end>` | `-l` | Extract specific lines from file (e.g., 50-100) |
| `--context <path>` | `-c` | Additional context file (can repeat) |
| `--system <prompt>` | `-s` | Custom system prompt |
| `--temperature <n>` | `-t` | Temperature 0-1 (default: 0.7) |
| `--quiet` | `-q` | Suppress status messages and usage stats |
| `--list` | | List available models |
| `--json` | | Output raw JSON response |

### Available Models

| Model ID | Aliases | Provider | Notes |
|----------|---------|----------|-------|
| `google/gemini-3-pro-preview` | `gemini`, `g3` | OpenRouter | Default - good for external perspective |
| `openai/gpt-5.1-codex` | `gpt`, `codex`, `gpt5` | OpenRouter | Strong at code analysis |
| `anthropic/claude-opus-4.5` | `opus`, `claude-opus` | Agent SDK | Uses local subscription |
| `anthropic/claude-sonnet-4.5` | `sonnet`, `claude` | Agent SDK | Uses local subscription |

Anthropic models route through Claude Agent SDK (uses your Claude subscription).
Other models route through OpenRouter API (requires `OPENROUTER_API_KEY`).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | For non-Anthropic models | OpenRouter API key |
| `AGENT_REVIEW_DEFAULT_MODEL` | No | Override default model |

## Examples

### Code Review

```bash
# Review a file for security issues
cat src/server/auth.ts | node .claude/skills/agent-review/query.mjs \
  "Review this authentication code for security vulnerabilities"

# Review with a specific model (using alias)
node .claude/skills/agent-review/query.mjs -m gpt -f src/utils/parser.ts \
  "Review this parser for edge cases and error handling"
```

### Reviewing Specific Lines

```bash
# Review a specific function (lines 50-100)
node .claude/skills/agent-review/query.mjs \
  -f src/server/auth.ts -l 50-100 \
  "Review this authentication function for security issues"

# Review a single line
node .claude/skills/agent-review/query.mjs \
  -f src/utils/parser.ts -l 42 \
  "Is this regex safe from ReDoS attacks?"
```

### With Context Files

```bash
# Review code with type definitions as context
node .claude/skills/agent-review/query.mjs \
  -f src/api/routes.ts \
  -c src/types/api.ts \
  -c src/types/models.ts \
  "Review this API implementation"

# Review component with its hooks as context
node .claude/skills/agent-review/query.mjs \
  -f src/components/UserProfile.tsx \
  -c src/hooks/useUser.ts \
  "Review this React component for performance issues"
```

### Architecture Feedback

```bash
# Get feedback on a proposed design
cat docs/design-proposal.md | node .claude/skills/agent-review/query.mjs \
  "What are the potential issues with this architecture?"
```

### Custom System Prompt

```bash
node .claude/skills/agent-review/query.mjs \
  -f src/api/routes.ts \
  -s "You are a security expert specializing in API design" \
  "Audit this API for OWASP top 10 vulnerabilities"
```

### Temperature Control

```bash
# Lower temperature for more deterministic analysis
node .claude/skills/agent-review/query.mjs -t 0.2 -f src/algo.ts \
  "Analyze the time complexity"

# Higher temperature for creative suggestions
node .claude/skills/agent-review/query.mjs -t 0.9 -f src/ui.tsx \
  "Suggest ways to improve the user experience"
```

### Using Anthropic Models (Local Subscription)

```bash
# Uses Claude Agent SDK - no API credits consumed
node .claude/skills/agent-review/query.mjs -m opus -f complex-algorithm.ts \
  "Analyze the time complexity and suggest optimizations"
```

### Quiet Mode (for scripting)

```bash
# Suppress all status messages, only output the response
REVIEW=$(node .claude/skills/agent-review/query.mjs -q -f src/auth.ts \
  "List security issues as JSON array")
echo "$REVIEW" | jq .
```

## Output

The response text is written to stdout. After the response, usage stats are shown on stderr:

```
Tokens: 189 in / 871 out (1060 total)
Cost: $0.0108
```

This helps track token consumption and costs for OpenRouter requests. Use `--quiet` to suppress.

## When to Use

- **Code Review**: Get a second opinion on code quality, security, or performance
- **Architecture Decisions**: Validate design choices with another perspective
- **Bug Analysis**: Share error context and get debugging suggestions
- **Documentation Review**: Check if docs are clear and complete
- **Test Coverage**: Identify missing test cases

## Tips

- Default model (Gemini 3 Pro) is recommended for most external reviews
- Use Anthropic models when you want consistency with Claude's style
- Use `-l` to review specific functions without sending the entire file (saves tokens)
- Use `-c` to include type definitions or related files for better context
- Use `-t 0.2` for more focused/deterministic responses, `-t 0.8` for creative suggestions
- Pipe code directly for quick reviews: `cat file.ts | node ... "review this"`
