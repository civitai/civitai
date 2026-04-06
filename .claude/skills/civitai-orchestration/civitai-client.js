/**
 * Civitai Orchestration Client
 *
 * Part of the civitai-orchestration skill for Claude Code.
 * Interacts with the Civitai Orchestration API to query workflows,
 * view job details, and retrieve generation results.
 *
 * Usage:
 *   node civitai-client.js <command> [options]
 *
 * Commands:
 *   workflows [options]           - List/search workflows
 *   workflow <id> [--wait]        - Get workflow details
 *   step <workflowId> <stepName>  - Get step details
 *   results <workflowId>          - View/download results
 *   blob <blobId>                 - Get blob (image/video)
 *   test                          - Test API connection
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Load environment variables
const SKILL_DIR = __dirname;
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');

const skillEnvPath = path.join(SKILL_DIR, '.env');
const rootEnvPath = path.join(PROJECT_ROOT, '.env');

if (fs.existsSync(skillEnvPath)) {
  require('dotenv').config({ path: skillEnvPath });
} else if (fs.existsSync(rootEnvPath)) {
  require('dotenv').config({ path: rootEnvPath });
}

// Configuration
const API_URL = process.env.CIVITAI_API_URL || 'https://orchestration-new.civitai.com';
const API_TOKEN = process.env.CIVITAI_API_TOKEN;

/**
 * Parse command line arguments
 * Supports multiple values for the same key (e.g., --tag=a --tag=b)
 */
function parseArgs(args) {
  let command = null;
  const remaining = [];
  const options = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const [key, ...valueParts] = arg.slice(2).split('=');
      const value = valueParts.length > 0 ? valueParts.join('=') : true;

      // Support multiple values for the same key (like --tag)
      if (options[key] !== undefined) {
        if (Array.isArray(options[key])) {
          options[key].push(value);
        } else {
          options[key] = [options[key], value];
        }
      } else {
        options[key] = value;
      }
    } else if (!command) {
      command = arg;
    } else {
      remaining.push(arg);
    }
  }

  return { command, remaining, options };
}

/**
 * Make an API request to Civitai Orchestration
 */
async function apiRequest(method, endpoint, body = null, queryParams = {}) {
  // Build query string
  const queryParts = [];
  for (const [key, value] of Object.entries(queryParams)) {
    if (value !== undefined && value !== null && value !== '') {
      if (Array.isArray(value)) {
        value.forEach(v => queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`));
      } else {
        queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      }
    }
  }
  const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';

  const url = `${API_URL}${endpoint}${queryString}`;

  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Handle redirects for blob requests
  if (response.status === 308) {
    const location = response.headers.get('location');
    return { redirect: location };
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API request failed: ${response.status} ${error}`);
  }

  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json();
  }

  return response.text();
}

/**
 * Query workflows for a specific user (requires Manager token)
 */
async function queryUserWorkflows(userId, options = {}) {
  if (!userId) {
    console.error('Error: user ID required');
    console.error('Usage: node civitai-client.js user-workflows <userId> [options]');
    return null;
  }

  if (!API_TOKEN) {
    console.error('Error: CIVITAI_API_TOKEN not set');
    return null;
  }

  console.log(`\n--- Civitai Orchestration: User ${userId} Workflows ---\n`);

  // Build query params for manager endpoint
  const queryParams = {
    UserId: userId,
  };

  if (options.take) {
    queryParams.Take = parseInt(options.take, 10);
  }

  if (options.cursor) {
    queryParams.Cursor = options.cursor;
  }

  if (options.tag) {
    const tags = Array.isArray(options.tag) ? options.tag : [options.tag];
    queryParams.Tags = tags;
  }

  if (options.query) {
    queryParams.Query = options.query;
  }

  if (options.excludeFailed) {
    queryParams.ExcludeFailed = true;
  }

  if (options.oldest || options.ascending) {
    queryParams.Inverse = true;
  }

  // Build query string
  const queryParts = [];
  for (const [key, value] of Object.entries(queryParams)) {
    if (value !== undefined && value !== null && value !== '') {
      if (Array.isArray(value)) {
        value.forEach(v => queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`));
      } else {
        queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      }
    }
  }
  const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';

  const url = `${API_URL}/v1/manager/workflows${queryString}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Manager API request failed: ${response.status} ${error}`);
  }

  const workflows = await response.json();

  if (!workflows || workflows.length === 0) {
    console.log('No workflows found for this user.');
    return [];
  }

  console.log(`Found ${workflows.length} workflow(s):\n`);

  for (const w of workflows) {
    console.log(`ID: ${w.id}`);
    console.log(`  Status: ${w.status}`);
    console.log(`  Created: ${w.createdAt}`);
    if (w.completedAt) {
      console.log(`  Completed: ${w.completedAt}`);
    }
    if (w.tags && w.tags.length > 0) {
      console.log(`  Tags: ${w.tags.join(', ')}`);
    }
    if (w.steps && w.steps.length > 0) {
      const stepSummary = w.steps.map(s => {
        const type = s.$type || 'unknown';
        return `${s.name}:${type}(${s.status || 'unknown'})`;
      }).join(', ');
      console.log(`  Steps: ${stepSummary}`);

      // Show prompts for text-to-image steps
      for (const step of w.steps) {
        if (step.$type === 'textToImage' && step.input?.prompt) {
          const prompt = step.input.prompt.substring(0, 100);
          console.log(`  Prompt: "${prompt}${step.input.prompt.length > 100 ? '...' : ''}"`);
        }
      }
    }
    console.log('');
  }

  return workflows;
}

/**
 * List workflows with optional filters (consumer endpoint - own workflows only)
 */
async function listWorkflows(options = {}) {
  console.log('\n--- Civitai Orchestration: List Workflows ---\n');

  // Display active filters
  const filters = [];
  if (options.tag) filters.push(`tag: ${Array.isArray(options.tag) ? options.tag.join(', ') : options.tag}`);
  if (options.from) filters.push(`from: ${options.from}`);
  if (options.to) filters.push(`to: ${options.to}`);
  if (options.status) filters.push(`status: ${options.status}`);
  if (options.query) filters.push(`query: "${options.query}"`);
  if (filters.length > 0) {
    console.log(`Filters: ${filters.join(' | ')}\n`);
  }

  const queryParams = {};

  // Handle tags (can be multiple via --tag=a --tag=b)
  if (options.tag) {
    const tags = Array.isArray(options.tag) ? options.tag : [options.tag];
    // API expects tags as separate query params: tags=a&tags=b
    queryParams.tags = tags;
  }

  // Handle date range (API uses fromDate/toDate)
  // Assume UTC if no timezone specified (append Z for ISO datetime strings)
  if (options.from) {
    let fromStr = options.from;
    // If it looks like ISO datetime without timezone, assume UTC
    if (fromStr.includes('T') && !fromStr.includes('Z') && !fromStr.includes('+') && !fromStr.includes('-', 11)) {
      fromStr += 'Z';
    }
    queryParams.fromDate = new Date(fromStr).toISOString();
  }
  if (options.to) {
    let toStr = options.to;
    // If only date provided (no T), set to end of day UTC
    if (!toStr.includes('T')) {
      toStr += 'T23:59:59.999Z';
    } else if (!toStr.includes('Z') && !toStr.includes('+') && !toStr.includes('-', 11)) {
      // If ISO datetime without timezone, assume UTC
      toStr += 'Z';
    }
    queryParams.toDate = new Date(toStr).toISOString();
  }

  // Handle status filtering (API uses excludeFailed boolean, not status string)
  // Note: API doesn't support direct status filtering, only excludeFailed
  if (options.excludeFailed || options.status === 'succeeded') {
    queryParams.excludeFailed = true;
  }

  // Pagination
  if (options.take) {
    queryParams.take = parseInt(options.take, 10);
  } else {
    queryParams.take = 20; // Default
  }

  if (options.cursor) {
    queryParams.cursor = options.cursor;
  }

  // Query filter (searches metadata)
  if (options.query) {
    queryParams.query = options.query;
  }

  // Sort order (default: newest first)
  if (options.ascending || options.oldest) {
    queryParams.ascending = true;
  }

  const result = await apiRequest('GET', '/v2/consumer/workflows', null, queryParams);

  if (!result || !result.items) {
    console.log('No workflows found.');
    return result;
  }

  console.log(`Found ${result.items.length} workflow(s):`);
  if (result.nextCursor) {
    console.log(`Next cursor: ${result.nextCursor}`);
  }
  console.log('');

  for (const workflow of result.items) {
    console.log(`ID: ${workflow.id}`);
    console.log(`  Status: ${workflow.status}`);
    console.log(`  Created: ${workflow.createdAt}`);
    if (workflow.completedAt) {
      console.log(`  Completed: ${workflow.completedAt}`);
    }
    if (workflow.tags && workflow.tags.length > 0) {
      console.log(`  Tags: ${workflow.tags.join(', ')}`);
    }
    if (workflow.steps && workflow.steps.length > 0) {
      console.log(`  Steps: ${workflow.steps.map(s => `${s.name}(${s.status})`).join(', ')}`);
    }
    console.log('');
  }

  return result;
}

/**
 * Get a specific workflow by ID
 */
async function getWorkflow(workflowId, options = {}) {
  if (!workflowId) {
    console.error('Error: workflow ID required');
    console.error('Usage: node civitai-client.js workflow <workflowId>');
    return null;
  }

  console.log(`\n--- Civitai Orchestration: Workflow ${workflowId} ---\n`);

  const queryParams = {};
  if (options.wait) {
    queryParams.wait = true;
  }

  const workflow = await apiRequest('GET', `/v2/consumer/workflows/${workflowId}`, null, queryParams);

  console.log('Workflow Details:');
  console.log(JSON.stringify(workflow, null, 2));

  return workflow;
}

/**
 * Get job details by ID
 * Always fetches with detailed=true to include lastEvent context
 */
async function getJob(jobId, options = {}) {
  if (!jobId) {
    console.error('Error: job ID required');
    console.error('Usage: node civitai-client.js job <jobId> [--raw]');
    return null;
  }

  console.log(`\n--- Civitai Orchestration: Job ${jobId} ---\n`);

  // Always fetch detailed to get lastEvent context
  const queryParams = { detailed: true };

  const response = await apiRequest('GET', `/v1/consumer/jobs/${jobId}`, null, queryParams);

  // If raw output requested, just dump JSON
  if (options.raw) {
    console.log(JSON.stringify(response, null, 2));
    return response;
  }

  // Parse and display in a readable format
  const job = response.job || response;

  console.log('Job Summary:');
  console.log(`  ID: ${job.id || response.jobId}`);
  console.log(`  Type: ${job.type || job.Type}`);
  console.log(`  Created: ${job.createdAt}`);
  console.log(`  Cost: ${response.cost || job.cost}`);

  if (job.properties?.workflowId) {
    console.log(`  Workflow ID: ${job.properties.workflowId}`);
  }

  // Show prompt info for text-to-image jobs
  if (job.params?.prompt) {
    const prompt = job.params.prompt.length > 200
      ? job.params.prompt.substring(0, 200) + '...'
      : job.params.prompt;
    console.log(`\nPrompt: "${prompt}"`);
  }

  if (job.params?.negativePrompt) {
    const negPrompt = job.params.negativePrompt.length > 100
      ? job.params.negativePrompt.substring(0, 100) + '...'
      : job.params.negativePrompt;
    console.log(`Negative: "${negPrompt}"`);
  }

  // Show prompt classification if available
  if (job.promptClassificationResult) {
    const pcr = job.promptClassificationResult;
    const flags = [];
    if (pcr.sexual) flags.push('sexual');
    if (pcr.young) flags.push('young');
    if (pcr.cr) flags.push('CR');
    if (pcr.scan) flags.push('scan');
    console.log(`\nPrompt Classification: ${flags.join(', ') || 'none'}`);
  }

  // Show results/blobs
  if (response.result && response.result.length > 0) {
    console.log(`\nResults (${response.result.length} blob(s)):`);
    for (const r of response.result) {
      console.log(`  - ${r.blobKey} (available: ${r.available})`);
    }
  }

  // Show last event details - this is where the important context lives
  if (response.lastEvent) {
    const evt = response.lastEvent;
    console.log(`\nLast Event:`);
    console.log(`  Type: ${evt.type}`);
    console.log(`  Time: ${evt.dateTime}`);
    console.log(`  Provider: ${evt.provider}`);
    console.log(`  Worker: ${evt.workerId}`);
    console.log(`  Job Duration: ${evt.jobDuration}`);

    // Show context - this has the scan results!
    if (evt.context) {
      console.log(`\nEvent Context (scan results, metrics):`);

      // Highlight important scan-related fields
      const importantFields = [
        'hive_csam_score',
        'hive_vlm_summary',
        'blocked_reason',
        'nsfwLevel'
      ];

      for (const field of importantFields) {
        if (evt.context[field]) {
          console.log(`  ** ${field}: ${evt.context[field]}`);
        }
      }

      // Show other context fields
      const otherFields = Object.keys(evt.context).filter(k => !importantFields.includes(k));
      if (otherFields.length > 0) {
        console.log(`  Other context:`);
        for (const key of otherFields) {
          const value = evt.context[key];
          const displayValue = typeof value === 'string' && value.length > 80
            ? value.substring(0, 80) + '...'
            : value;
          console.log(`    ${key}: ${displayValue}`);
        }
      }
    }
  }

  return response;
}

/**
 * Get step details from a workflow
 */
async function getStep(workflowId, stepName, options = {}) {
  if (!workflowId || !stepName) {
    console.error('Error: workflow ID and step name required');
    console.error('Usage: node civitai-client.js step <workflowId> <stepName>');
    return null;
  }

  console.log(`\n--- Civitai Orchestration: Step ${stepName} in ${workflowId} ---\n`);

  const step = await apiRequest('GET', `/v2/consumer/workflows/${workflowId}/steps/${stepName}`, null, {});

  console.log('Step Details:');
  console.log(JSON.stringify(step, null, 2));

  return step;
}

/**
 * View or download results from a workflow
 */
async function getResults(workflowId, options = {}) {
  if (!workflowId) {
    console.error('Error: workflow ID required');
    console.error('Usage: node civitai-client.js results <workflowId> [--download] [--dir=<path>]');
    return null;
  }

  console.log(`\n--- Civitai Orchestration: Results for ${workflowId} ---\n`);

  // First get the workflow to find result data
  const workflow = await apiRequest('GET', `/v2/consumer/workflows/${workflowId}`);

  if (!workflow) {
    console.error('Workflow not found');
    return null;
  }

  console.log(`Status: ${workflow.status}`);
  console.log(`Steps: ${workflow.steps?.length || 0}`);
  console.log('');

  const results = [];

  // Iterate through steps to find outputs
  if (workflow.steps) {
    for (const step of workflow.steps) {
      console.log(`Step: ${step.name} (${step.status})`);

      if (step.output) {
        console.log('  Output:');

        // Handle different output formats
        if (step.output.images) {
          for (const img of step.output.images) {
            console.log(`    Image: ${img.url || img.id || JSON.stringify(img)}`);
            results.push({ type: 'image', data: img, stepName: step.name });
          }
        }

        if (step.output.videos) {
          for (const vid of step.output.videos) {
            console.log(`    Video: ${vid.url || vid.id || JSON.stringify(vid)}`);
            results.push({ type: 'video', data: vid, stepName: step.name });
          }
        }

        if (step.output.blobId) {
          console.log(`    Blob ID: ${step.output.blobId}`);
          results.push({ type: 'blob', id: step.output.blobId, stepName: step.name });
        }

        if (step.output.blobIds) {
          for (const blobId of step.output.blobIds) {
            console.log(`    Blob ID: ${blobId}`);
            results.push({ type: 'blob', id: blobId, stepName: step.name });
          }
        }

        // Handle blob output (common for convertImage, textToImage, etc.)
        if (step.output.blob) {
          const blob = step.output.blob;
          console.log(`    Blob: ${blob.id}`);
          console.log(`    Size: ${blob.width}x${blob.height}`);
          console.log(`    URL: ${blob.url?.substring(0, 100)}...`);
          results.push({
            type: blob.id?.endsWith('.mp4') ? 'video' : 'image',
            data: blob,
            stepName: step.name,
            url: blob.url
          });
        }

        // Generic output for any other format
        if (!step.output.images && !step.output.videos && !step.output.blobId && !step.output.blobIds && !step.output.blob) {
          console.log(`    ${JSON.stringify(step.output, null, 2).substring(0, 500)}`);
        }
      }

      if (step.metadata) {
        console.log(`  Metadata: ${JSON.stringify(step.metadata).substring(0, 200)}`);
      }

      console.log('');
    }
  }

  // Download if requested
  if (options.download && results.length > 0) {
    const downloadDir = options.dir || './civitai-downloads';

    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }

    console.log(`\nDownloading ${results.length} result(s) to ${downloadDir}...`);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      let downloadUrl = null;
      let ext = '.png';

      // Determine download URL and file extension
      if (result.url) {
        downloadUrl = result.url;
        // Infer extension from blob ID or URL
        if (result.data?.id) {
          const blobId = result.data.id;
          if (blobId.endsWith('.webp')) ext = '.webp';
          else if (blobId.endsWith('.mp4')) ext = '.mp4';
          else if (blobId.endsWith('.jpg') || blobId.endsWith('.jpeg')) ext = '.jpg';
          else if (blobId.endsWith('.png')) ext = '.png';
        }
      } else if (result.type === 'blob' && result.id) {
        try {
          downloadUrl = await getBlobUrl(result.id);
        } catch (e) {
          console.error(`  Failed to get blob URL ${result.id}: ${e.message}`);
          continue;
        }
      } else if (result.data?.url) {
        downloadUrl = result.data.url;
      }

      if (downloadUrl) {
        try {
          const filename = `${workflowId}_${result.stepName}_${i}${ext}`;
          const filepath = path.join(downloadDir, filename);
          await downloadFile(downloadUrl, filepath);
          console.log(`  Downloaded: ${filename}`);
        } catch (e) {
          console.error(`  Failed to download: ${e.message}`);
        }
      }
    }
  }

  return { workflow, results };
}

/**
 * Get blob URL (follows redirect)
 */
async function getBlobUrl(blobId, options = {}) {
  const queryParams = {};
  if (options.nsfw) {
    queryParams.hideMatureContent = false;
  }

  try {
    const result = await apiRequest('GET', `/v2/consumer/blobs/${blobId}`, null, queryParams);
    if (result && result.redirect) {
      return result.redirect;
    }
    return result;
  } catch (e) {
    // The blob endpoint returns a redirect, which fetch might handle automatically
    throw e;
  }
}

/**
 * Get blob details or download
 */
async function getBlob(blobId, options = {}) {
  if (!blobId) {
    console.error('Error: blob ID required');
    console.error('Usage: node civitai-client.js blob <blobId> [--download] [--nsfw]');
    return null;
  }

  console.log(`\n--- Civitai Orchestration: Blob ${blobId} ---\n`);

  const queryParams = {};
  if (options.nsfw) {
    queryParams.hideMatureContent = false;
  }

  // The blob endpoint returns a 308 redirect to the actual content
  const url = `${API_URL}/v2/consumer/blobs/${blobId}`;
  console.log(`Blob URL: ${url}`);

  if (options.download) {
    const downloadDir = options.dir || './civitai-downloads';
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }

    const filename = `${blobId}.png`;
    const filepath = path.join(downloadDir, filename);

    console.log(`Downloading to ${filepath}...`);

    // Follow redirects and download
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    fs.writeFileSync(filepath, Buffer.from(buffer));
    console.log(`Downloaded: ${filename} (${buffer.byteLength} bytes)`);
  }

  return { blobId, url };
}

/**
 * Download a file from URL
 */
async function downloadFile(url, filepath) {
  const response = await fetch(url, { redirect: 'follow' });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  fs.writeFileSync(filepath, Buffer.from(buffer));
}

/**
 * Test API connection
 */
async function testConnection() {
  console.log('\n--- Civitai Orchestration: Testing Connection ---\n');

  if (!API_TOKEN) {
    console.error('Error: CIVITAI_API_TOKEN not set');
    console.error('Set it in .claude/skills/civitai-orchestration/.env');
    return false;
  }

  console.log(`API URL: ${API_URL}`);
  console.log(`Token: ${API_TOKEN.substring(0, 8)}...`);

  try {
    // Try to list a single workflow to test the connection
    const result = await apiRequest('GET', '/v2/consumer/workflows', null, { take: 1 });
    console.log('\nConnection successful!');
    console.log(`Found ${result.items?.length || 0} workflow(s) in test query`);
    return true;
  } catch (e) {
    console.error(`\nConnection failed: ${e.message}`);
    return false;
  }
}

/**
 * Show help
 */
function showHelp() {
  console.log('Civitai Orchestration Client');
  console.log('============================');
  console.log('');
  console.log('Usage: node civitai-client.js <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  test                              - Test API connection');
  console.log('');
  console.log('  user-workflows <userId> [options] - Query workflows for a specific user (Manager)');
  console.log('  user <userId> [options]           - Alias for user-workflows');
  console.log('    --take=<n>                      - Number of results (max 10)');
  console.log('    --tag=<tag>                     - Filter by tag');
  console.log('    --query=<text>                  - Search metadata');
  console.log('    --excludeFailed                 - Exclude failed workflows');
  console.log('    --oldest                        - Sort from oldest to newest');
  console.log('');
  console.log('  workflows [options]               - List own workflows (Consumer)');
  console.log('    --tag=<tag>                     - Filter by tag');
  console.log('    --take=<n>                      - Number of results');
  console.log('    --cursor=<cursor>               - Pagination cursor');
  console.log('    --query=<text>                  - Search metadata');
  console.log('    --excludeFailed                 - Exclude failed workflows');
  console.log('    --oldest                        - Sort from oldest to newest');
  console.log('');
  console.log('  workflow <id> [--wait]            - Get workflow details');
  console.log('  job <jobId> [--raw]               - Get job details with scan context');
  console.log('    --raw                           - Output raw JSON instead of formatted');
  console.log('  step <workflowId> <stepName>      - Get step details');
  console.log('  results <workflowId> [options]    - View/download results');
  console.log('    --download                      - Download result files');
  console.log('    --dir=<path>                    - Download directory');
  console.log('  blob <blobId> [options]           - Get blob (image/video)');
  console.log('    --download                      - Download the blob');
  console.log('    --nsfw                          - Allow NSFW content');
  console.log('');
  console.log('Environment Variables:');
  console.log('  CIVITAI_API_TOKEN                 - Bearer token for authentication');
  console.log('  CIVITAI_API_URL                   - API base URL (default: https://orchestration-new.civitai.com)');
}

// Main
async function main() {
  const { command, remaining, options } = parseArgs(process.argv.slice(2));

  try {
    switch (command) {
      case 'test':
        await testConnection();
        break;
      case 'user-workflows':
      case 'user':
        await queryUserWorkflows(remaining[0], options);
        break;
      case 'workflows':
        await listWorkflows(options);
        break;
      case 'workflow':
        await getWorkflow(remaining[0], options);
        break;
      case 'job':
        await getJob(remaining[0], options);
        break;
      case 'step':
        await getStep(remaining[0], remaining[1], options);
        break;
      case 'results':
        await getResults(remaining[0], options);
        break;
      case 'blob':
        await getBlob(remaining[0], options);
        break;
      default:
        showHelp();
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();

// Export for use in other scripts
module.exports = {
  apiRequest,
  queryUserWorkflows,
  listWorkflows,
  getWorkflow,
  getJob,
  getStep,
  getResults,
  getBlob,
  getBlobUrl,
  testConnection,
};
