# OpenRouter Integration Tests

Test scripts to verify the OpenRouter SDK integration is working correctly.

## Prerequisites

Set the `OPENROUTER_API_KEY` environment variable:

```bash
export OPENROUTER_API_KEY=your_api_key_here
```

Or create a `.env` file in the project root with:
```
OPENROUTER_API_KEY=your_api_key_here
```

## Running Tests

### Quick Connectivity Test
Minimal test to verify API connectivity:

```bash
npm run test:openrouter:quick
```

### Full SDK Test Suite
Tests various SDK features (JSON completion, vision, error handling, model aliases):

```bash
npm run test:openrouter
```

### Abstraction Layer Test
Tests the `openrouter.ts` abstraction layer with `getJsonCompletion` helper:

```bash
npm run test:openrouter:abstraction
```

## Test Files

- `quick-test.mjs` - Minimal connectivity test
- `test-openrouter.mjs` - Full SDK test suite (no TypeScript required)
- `test-abstraction.ts` - Tests the TypeScript abstraction layer

## What's Being Tested

1. **Basic JSON Completion** - Request/response with JSON format
2. **Model Aliases** - GPT-4o, GPT-4o-mini, Claude Sonnet, Claude Haiku
3. **Vision Capability** - Image URL processing
4. **Error Handling** - Invalid model errors
5. **Provider Fallback** - OpenRouter's fallback routing
6. **Retry Logic** - Automatic retry on failure (abstraction layer)
7. **SimpleMessage Format** - Our message format conversion

## Expected Output

```
========================================
   OpenRouter Integration Test Suite
========================================

API Key: sk-or-v...xxxx

--- Test: Basic JSON Completion ---
  PASS Basic JSON Completion - Got: {"message":"Hello!","number":42}
  Tokens: 35 prompt + 12 completion = 47 total

--- Test: Different Model Aliases ---
  PASS Model: GPT-4o-mini - Response: {"model":"GPT-4o-mini","status":"ok"}
  PASS Model: Claude Haiku - Response: {"model":"Claude Haiku","status":"ok"}

...

========================================
   Test Summary
========================================

Passed: 8
Failed: 0
Total:  8
```
