#!/usr/bin/env node

/**
 * Agent Review - External AI consultation
 *
 * Routes requests to appropriate provider:
 * - Anthropic models -> Claude Agent SDK (local subscription)
 * - Other models -> OpenRouter API
 *
 * Usage:
 *   echo "code" | node query.mjs "Review this code"
 *   node query.mjs --file src/auth.ts "Check for security issues"
 *   node query.mjs --file src/auth.ts --lines 50-100 "Review this function"
 *
 * Options:
 *   --model <model>      Model to use (default: gemini)
 *   --file <path>        Read input from file instead of stdin
 *   --lines <start-end>  Extract specific lines from file (e.g., 50-100)
 *   --context <path>     Additional context file (can be used multiple times)
 *   --system <prompt>    Custom system prompt
 *   --temperature <n>    Temperature 0-1 (default: 0.7)
 *   --quiet              Suppress status messages and usage stats
 *   --list               List available models
 *   --json               Output raw JSON response
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { stdin } from 'process';

// Load .env from project root
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

function loadEnv() {
  try {
    const envPath = resolve(projectRoot, '.env');
    const envContent = readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex);
      const value = trimmed.slice(eqIndex + 1);
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (e) {
    // .env not found, that's ok
  }
}

loadEnv();

// Available models with aliases
const MODELS = {
  'google/gemini-3-pro-preview': {
    provider: 'openrouter',
    name: 'Gemini 3 Pro Preview',
    aliases: ['gemini', 'gemini-3', 'g3']
  },
  'openai/gpt-5.1-codex': {
    provider: 'openrouter',
    name: 'GPT-5.1 Codex',
    aliases: ['gpt', 'codex', 'gpt5']
  },
  'anthropic/claude-opus-4.5': {
    provider: 'anthropic',
    name: 'Claude Opus 4.5',
    sdkModel: 'opus',
    aliases: ['opus', 'claude-opus']
  },
  'anthropic/claude-sonnet-4.5': {
    provider: 'anthropic',
    name: 'Claude Sonnet 4.5',
    sdkModel: 'sonnet',
    aliases: ['sonnet', 'claude-sonnet', 'claude']
  },
};

// Build alias lookup
const MODEL_ALIASES = {};
for (const [id, info] of Object.entries(MODELS)) {
  MODEL_ALIASES[id] = id; // Full ID maps to itself
  for (const alias of info.aliases || []) {
    MODEL_ALIASES[alias] = id;
  }
}

const DEFAULT_MODEL = process.env.AGENT_REVIEW_DEFAULT_MODEL || 'google/gemini-3-pro-preview';

// Resolve model alias to full ID
function resolveModel(input) {
  const lower = input.toLowerCase();
  return MODEL_ALIASES[lower] || MODEL_ALIASES[input] || input;
}

// Parse arguments
const args = process.argv.slice(2);
let modelInput = null;
let filePath = null;
let lineRange = null;
let contextFiles = [];
let systemPrompt = null;
let temperature = 0.7;
let quietMode = false;
let jsonOutput = false;
let listModels = false;
const positionalArgs = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--model' || arg === '-m') {
    modelInput = args[++i];
  } else if (arg === '--file' || arg === '-f') {
    filePath = args[++i];
  } else if (arg === '--lines' || arg === '-l') {
    lineRange = args[++i];
  } else if (arg === '--context' || arg === '-c') {
    contextFiles.push(args[++i]);
  } else if (arg === '--system' || arg === '-s') {
    systemPrompt = args[++i];
  } else if (arg === '--temperature' || arg === '-t') {
    temperature = parseFloat(args[++i]);
    if (isNaN(temperature) || temperature < 0 || temperature > 1) {
      console.error('Error: Temperature must be between 0 and 1');
      process.exit(1);
    }
  } else if (arg === '--quiet' || arg === '-q') {
    quietMode = true;
  } else if (arg === '--json') {
    jsonOutput = true;
  } else if (arg === '--list') {
    listModels = true;
  } else if (!arg.startsWith('-')) {
    positionalArgs.push(arg);
  }
}

// Resolve model
const model = resolveModel(modelInput || DEFAULT_MODEL);

if (listModels) {
  console.log('Available models:\n');
  for (const [id, info] of Object.entries(MODELS)) {
    const isDefault = id === DEFAULT_MODEL ? ' (default)' : '';
    const aliases = info.aliases?.length ? ` [${info.aliases.join(', ')}]` : '';
    console.log(`  ${id}${isDefault}`);
    console.log(`    Provider: ${info.provider}, Aliases: ${aliases}`);
  }
  process.exit(0);
}

const userPrompt = positionalArgs.join(' ');

if (!userPrompt) {
  console.error(`Usage: node query.mjs [options] "Your prompt"

Options:
  --model, -m <model>      Model or alias (default: gemini)
  --file, -f <path>        Read input from file instead of stdin
  --lines, -l <start-end>  Extract specific lines from file (e.g., 50-100)
  --context, -c <path>     Additional context file (can repeat)
  --system, -s <prompt>    Custom system prompt
  --temperature, -t <n>    Temperature 0-1 (default: 0.7)
  --quiet, -q              Suppress status messages
  --list                   List available models
  --json                   Output raw JSON response

Model Aliases:
  gemini, g3      -> google/gemini-3-pro-preview
  gpt, codex      -> openai/gpt-5.1-codex
  opus            -> anthropic/claude-opus-4.5
  sonnet, claude  -> anthropic/claude-sonnet-4.5

Examples:
  cat code.ts | node query.mjs "Review this code"
  node query.mjs -f src/auth.ts "Check for security issues"
  node query.mjs -f src/auth.ts -l 50-100 "Review this function"
  node query.mjs -f api.ts -c types.ts "Review with type context"
  node query.mjs -m gpt -f api.ts "Review this"`);
  process.exit(1);
}

// Determine provider
const modelInfo = MODELS[model];
const provider = modelInfo?.provider || (model.startsWith('anthropic/') ? 'anthropic' : 'openrouter');

// Parse line range (e.g., "50-100" or "50")
function parseLineRange(range) {
  if (!range) return null;
  const match = range.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) {
    console.error(`Error: Invalid line range format: ${range}`);
    console.error('Use format: start-end (e.g., 50-100) or single line (e.g., 50)');
    process.exit(1);
  }
  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : start;
  if (start > end) {
    console.error(`Error: Start line (${start}) cannot be greater than end line (${end})`);
    process.exit(1);
  }
  return { start, end };
}

// Extract lines from content
function extractLines(content, range) {
  if (!range) return content;
  const lines = content.split('\n');
  const { start, end } = range;

  if (start < 1 || start > lines.length) {
    console.error(`Error: Start line ${start} is out of range (file has ${lines.length} lines)`);
    process.exit(1);
  }

  // Extract lines (1-indexed) and add line numbers for context
  const extracted = [];
  const actualEnd = Math.min(end, lines.length);
  for (let i = start - 1; i < actualEnd; i++) {
    extracted.push(`${i + 1}: ${lines[i]}`);
  }

  return extracted.join('\n');
}

// Read a file with optional line range
function readFileContent(path, range = null) {
  const absPath = resolve(process.cwd(), path);
  if (!existsSync(absPath)) {
    console.error(`Error: File not found: ${absPath}`);
    process.exit(1);
  }
  let content = readFileSync(absPath, 'utf-8');

  if (range) {
    const parsedRange = parseLineRange(range);
    if (parsedRange) {
      content = extractLines(content, parsedRange);
    }
  }

  return content;
}

// Read input (stdin or file)
async function getInput() {
  if (filePath) {
    const range = parseLineRange(lineRange);
    const content = readFileContent(filePath, lineRange);

    if (!quietMode && range) {
      console.error(`Extracted lines ${range.start}-${range.end} from ${filePath}\n`);
    }

    return { content, fileName: basename(filePath), range };
  }

  // Check if stdin has data
  if (stdin.isTTY) {
    return { content: '', fileName: null, range: null };
  }

  return new Promise((resolve) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => { data += chunk; });
    stdin.on('end', () => resolve({ content: data, fileName: null, range: null }));
  });
}

// Read context files
function getContextContent() {
  if (contextFiles.length === 0) return '';

  const parts = [];
  for (const file of contextFiles) {
    const content = readFileContent(file);
    const name = basename(file);
    parts.push(`--- Context: ${name} ---\n${content}`);
  }
  return parts.join('\n\n');
}

// Format cost for display
function formatCost(cost) {
  if (cost < 0.01) {
    return `$${cost.toFixed(6)}`;
  }
  return `$${cost.toFixed(4)}`;
}

// OpenRouter provider
async function callOpenRouter(model, messages, temperature) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('Error: OPENROUTER_API_KEY not configured');
    console.error('Required for non-Anthropic models.');
    process.exit(1);
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://civitai.com',
      'X-Title': 'Civitai Agent Review',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${text}`);
  }

  return response.json();
}

// Anthropic provider (Claude Agent SDK)
async function callAnthropic(model, messages) {
  try {
    // Dynamic import to avoid errors if not installed
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    // Convert messages to a single prompt
    const prompt = messages.map(m => {
      if (m.role === 'system') return `System: ${m.content}\n\n`;
      if (m.role === 'user') return m.content;
      return '';
    }).join('');

    // Map model names to SDK format (opus, sonnet, haiku)
    const modelInfo = MODELS[model];
    const sdkModel = modelInfo?.sdkModel || 'sonnet';

    let result = '';
    let usage = null;
    for await (const message of query({
      prompt,
      options: {
        model: sdkModel,
        allowedTools: [], // No tools for simple consultation
      },
    })) {
      // Extract text from response
      if (message.type === 'assistant' && message.content) {
        for (const block of message.content) {
          if (block.type === 'text') {
            result += block.text;
          }
        }
      }
      if (message.type === 'result') {
        result = message.result || result;
        if (message.usage) {
          usage = message.usage;
        }
      }
    }

    return {
      choices: [{ message: { content: result } }],
      model,
      provider: 'anthropic-agent-sdk',
      usage,
    };
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      console.error('Error: @anthropic-ai/claude-agent-sdk not installed');
      console.error('Run: npm install @anthropic-ai/claude-agent-sdk');
      process.exit(1);
    }
    throw err;
  }
}

async function main() {
  const { content: input, fileName, range } = await getInput();
  const contextContent = getContextContent();

  // Build messages
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  // Build user message with file info
  let content = userPrompt;

  // Add file name context if available
  if (fileName) {
    const lineInfo = range ? ` (lines ${range.start}-${range.end})` : '';
    content = `File: ${fileName}${lineInfo}\n\n${userPrompt}`;
  }

  // Add context files if any
  if (contextContent) {
    content += `\n\n${contextContent}`;
  }

  // Add main input
  if (input.trim()) {
    content += `\n\n---\n\n${input}`;
  }

  messages.push({ role: 'user', content });

  if (!quietMode) {
    console.error(`Using: ${model} (${provider})\n`);
  }

  try {
    let response;

    if (provider === 'anthropic') {
      response = await callAnthropic(model, messages);
    } else {
      response = await callOpenRouter(model, messages, temperature);
    }

    if (jsonOutput) {
      console.log(JSON.stringify(response, null, 2));
    } else {
      const text = response.choices?.[0]?.message?.content || '';
      console.log(text);

      // Display usage stats
      if (!quietMode && response.usage) {
        const { prompt_tokens, completion_tokens, total_tokens, cost } = response.usage;
        console.error('');
        console.error('---');
        console.error(`Tokens: ${prompt_tokens} in / ${completion_tokens} out (${total_tokens} total)`);
        if (cost !== undefined) {
          console.error(`Cost: ${formatCost(cost)}`);
        }
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
