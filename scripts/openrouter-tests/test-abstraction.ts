/**
 * Test script for the openrouter.ts abstraction layer
 *
 * Run with tsx:
 *   OPENROUTER_API_KEY=your_key npx tsx scripts/openrouter-tests/test-abstraction.ts
 *
 * Or with ts-node:
 *   OPENROUTER_API_KEY=your_key npx ts-node --esm scripts/openrouter-tests/test-abstraction.ts
 */

import { openrouter, AI_MODELS, type SimpleMessage } from '../../src/server/services/ai/openrouter';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  dim: '\x1b[2m',
};

function log(msg: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

// Test Results
const results: Array<{ name: string; passed: boolean; details: string }> = [];

function recordTest(name: string, passed: boolean, details = '') {
  results.push({ name, passed, details });
  const status = passed ? `${colors.green}PASS${colors.reset}` : `${colors.red}FAIL${colors.reset}`;
  console.log(`  ${status} ${name}${details ? ` - ${details}` : ''}`);
}

// Tests
async function testGetJsonCompletion() {
  log('\n--- Test: getJsonCompletion Helper ---', 'blue');

  if (!openrouter) {
    recordTest('Client Initialization', false, 'OpenRouter client not initialized - check OPENROUTER_API_KEY');
    return;
  }

  recordTest('Client Initialization', true, 'OpenRouter client initialized');

  // Test basic JSON completion
  try {
    type TestResponse = { greeting: string; number: number };

    const result = await openrouter.getJsonCompletion<TestResponse>({
      model: AI_MODELS.GPT_4O_MINI,
      messages: [
        {
          role: 'system',
          content: 'Always respond with valid JSON containing "greeting" (string) and "number" (integer).',
        },
        {
          role: 'user',
          content: 'Say hello and give me a random number.',
        },
      ],
      temperature: 0.7,
      maxTokens: 100,
    });

    const valid = typeof result.greeting === 'string' && typeof result.number === 'number';
    recordTest('getJsonCompletion Basic', valid, `Got: ${JSON.stringify(result)}`);
  } catch (error) {
    recordTest('getJsonCompletion Basic', false, (error as Error).message);
  }
}

async function testSimpleMessageFormat() {
  log('\n--- Test: SimpleMessage Format ---', 'blue');

  if (!openrouter) {
    recordTest('SimpleMessage Test', false, 'Client not initialized');
    return;
  }

  // Test with array content (multimodal format)
  try {
    const messages: SimpleMessage[] = [
      {
        role: 'system',
        content: [{ type: 'text', text: 'You are a helpful assistant. Reply with JSON.' }],
      },
      {
        role: 'user',
        content: 'Reply with {"format": "array_content_works"}',
      },
    ];

    type TestResponse = { format: string };
    const result = await openrouter.getJsonCompletion<TestResponse>({
      messages,
      maxTokens: 50,
    });

    recordTest('SimpleMessage Array Content', result.format === 'array_content_works', `Got: ${result.format}`);
  } catch (error) {
    recordTest('SimpleMessage Array Content', false, (error as Error).message);
  }
}

async function testRetryLogic() {
  log('\n--- Test: Retry Logic ---', 'blue');

  if (!openrouter) {
    recordTest('Retry Logic', false, 'Client not initialized');
    return;
  }

  // Test that retries work (hard to force failure, so just verify it completes)
  try {
    const result = await openrouter.getJsonCompletion<{ ok: boolean }>({
      model: AI_MODELS.GPT_4O_MINI,
      messages: [{ role: 'user', content: 'Reply with {"ok": true}' }],
      retries: 2,
      maxTokens: 30,
    });

    recordTest('Retry Logic', result.ok === true, 'Completed with retries enabled');
  } catch (error) {
    recordTest('Retry Logic', false, (error as Error).message);
  }
}

async function testModelAliases() {
  log('\n--- Test: Model Aliases ---', 'blue');

  // Verify AI_MODELS constants are correct format
  const expectedModels = {
    GPT_4O: 'openai/gpt-4o',
    GPT_4O_MINI: 'openai/gpt-4o-mini',
    CLAUDE_SONNET: 'anthropic/claude-sonnet-4',
    CLAUDE_HAIKU: 'anthropic/claude-3-5-haiku',
  };

  let allMatch = true;
  for (const [key, expected] of Object.entries(expectedModels)) {
    const actual = AI_MODELS[key as keyof typeof AI_MODELS];
    if (actual !== expected) {
      recordTest(`Model Alias: ${key}`, false, `Expected ${expected}, got ${actual}`);
      allMatch = false;
    }
  }

  if (allMatch) {
    recordTest('Model Aliases', true, 'All aliases match expected format');
  }
}

async function testWithDifferentModel() {
  log('\n--- Test: Claude Haiku via Abstraction ---', 'blue');

  if (!openrouter) {
    recordTest('Claude Haiku', false, 'Client not initialized');
    return;
  }

  try {
    type TestResponse = { model: string; response: string };
    const result = await openrouter.getJsonCompletion<TestResponse>({
      model: AI_MODELS.CLAUDE_HAIKU,
      messages: [
        {
          role: 'user',
          content: 'Reply with JSON: {"model": "claude", "response": "hello from haiku"}',
        },
      ],
      maxTokens: 50,
    });

    const valid = result.model === 'claude' && result.response.includes('haiku');
    recordTest('Claude Haiku', valid, `Got: ${JSON.stringify(result)}`);
  } catch (error) {
    recordTest('Claude Haiku', false, (error as Error).message);
  }
}

// Main
async function main() {
  log('\n========================================', 'yellow');
  log('   OpenRouter Abstraction Layer Tests', 'yellow');
  log('========================================\n', 'yellow');

  if (!process.env.OPENROUTER_API_KEY) {
    log('ERROR: OPENROUTER_API_KEY not set!', 'red');
    log('\nRun with:', 'dim');
    log('  OPENROUTER_API_KEY=your_key npx tsx scripts/openrouter-tests/test-abstraction.ts', 'dim');
    process.exit(1);
  }

  await testModelAliases();
  await testGetJsonCompletion();
  await testSimpleMessageFormat();
  await testRetryLogic();
  await testWithDifferentModel();

  // Summary
  log('\n========================================', 'yellow');
  log('   Summary', 'yellow');
  log('========================================\n', 'yellow');

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  log(`Passed: ${passed}`, 'green');
  log(`Failed: ${failed}`, failed > 0 ? 'red' : 'green');
  log(`Total:  ${results.length}\n`);

  if (failed > 0) {
    log('Failed tests:', 'red');
    results
      .filter((r) => !r.passed)
      .forEach((r) => {
        log(`  - ${r.name}: ${r.details}`, 'red');
      });
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  log(`\nFatal error: ${error.message}`, 'red');
  process.exit(1);
});
