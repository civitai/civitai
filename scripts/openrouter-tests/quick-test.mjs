#!/usr/bin/env node
/**
 * Quick OpenRouter Connectivity Test
 *
 * A minimal test to verify OpenRouter API connectivity.
 *
 * Usage:
 *   OPENROUTER_API_KEY=your_key node scripts/openrouter-tests/quick-test.mjs
 */

import { OpenRouter } from '@openrouter/sdk';

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('ERROR: Set OPENROUTER_API_KEY environment variable');
    process.exit(1);
  }

  console.log('Testing OpenRouter connectivity...');
  console.log(`API Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}\n`);

  const client = new OpenRouter({ apiKey });

  try {
    const response = await client.chat.send({
      model: 'openai/gpt-4o-mini',
      messages: [
        { role: 'user', content: 'Reply with JSON: {"status": "ok", "message": "OpenRouter is working!"}' }
      ],
      responseFormat: { type: 'json_object' },
      maxTokens: 50,
    });

    const content = response.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content);

    console.log('Response:', JSON.stringify(parsed, null, 2));
    console.log('\nUsage:');
    console.log(`  Prompt tokens:     ${response.usage?.promptTokens || 'N/A'}`);
    console.log(`  Completion tokens: ${response.usage?.completionTokens || 'N/A'}`);
    console.log(`  Total tokens:      ${response.usage?.totalTokens || 'N/A'}`);

    console.log('\n✓ OpenRouter is working!');
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
    process.exit(1);
  }
}

main();
