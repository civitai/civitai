#!/usr/bin/env node

/**
 * Freshdesk - Customer support platform skill via Freshdesk v2 API
 *
 * Commands:
 *   tickets                          List recent tickets
 *   ticket <id>                      Get ticket details
 *   search <query>                   Search tickets (Freshdesk query syntax)
 *   conversations <id>               View ticket conversations
 *   reply <id> <message>             Reply to a ticket
 *   note <id> <message>              Add an internal note
 *   update <id>                      Update ticket properties
 *   investigate <id>                  Full ticket investigation (ticket + conversations + contact)
 *   contact <id|email>               Look up a contact
 *   contacts <query>                 Search contacts
 *
 * Knowledge Base Commands:
 *   kb-categories                    List all KB categories
 *   kb-folders <category_id>         List folders in a category
 *   kb-articles <folder_id>          List articles in a folder
 *   kb-article <article_id>          View a single article
 *   kb-search <term>                 Search KB articles
 *   kb-create <folder_id> <title>    Create an article in a folder
 *   kb-update <article_id>           Update an article
 *
 * Options:
 *   --json                Output raw JSON
 *   --status <code>       Filter by status
 *   --priority <code>     Filter by priority
 *   --page <n>            Page number
 *   --set-status <code>   Set ticket status
 *   --set-priority <code> Set ticket priority
 *   --set-agent <id>      Assign to agent
 *   --set-group <id>      Assign to group
 *   --set-type <type>     Set ticket type
 *   --set-tag <tag>       Set ticket tag (replaces existing)
 *   --private             Make note private (default)
 *   --body <text>         Article body (for kb-create/kb-update)
 *   --set-title <text>    Set article title (for kb-update)
 *   --set-article-status <1|2>  Set article status: 1=draft, 2=published
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillDir = __dirname;
const projectRoot = resolve(__dirname, '../../..');

// Load .env files (skill-specific first, then project root)
function loadEnv() {
  const envFiles = [
    resolve(skillDir, '.env'),
    resolve(projectRoot, '.env'),
  ];

  for (const envPath of envFiles) {
    try {
      const envContent = readFileSync(envPath, 'utf-8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex);
        const value = trimmed.slice(eqIndex + 1).replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    } catch {
      // Ignore missing files
    }
  }
}

loadEnv();

// Configuration
const API_TOKEN = process.env.FRESHDESK_TOKEN;
const DOMAIN = (process.env.FRESHDESK_DOMAIN || '').replace(/\/$/, '');

const STATUS_MAP = { 2: 'Open', 3: 'Pending', 4: 'Resolved', 5: 'Closed' };
const PRIORITY_MAP = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

// Parse arguments
const args = process.argv.slice(2);
let command = null;
let targetInput = null;
let messageText = null;
let jsonOutput = false;
let statusFilter = null;
let priorityFilter = null;
let page = 1;
let setStatus = null;
let setPriority = null;
let setAgent = null;
let setGroup = null;
let setType = null;
let setTag = null;
let isPrivate = true;
let bodyText = null;
let setTitle = null;
let setArticleStatus = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json') {
    jsonOutput = true;
  } else if (arg === '--status') {
    statusFilter = args[++i];
  } else if (arg === '--priority') {
    priorityFilter = args[++i];
  } else if (arg === '--page') {
    page = parseInt(args[++i]) || 1;
  } else if (arg === '--set-status') {
    setStatus = parseInt(args[++i]);
  } else if (arg === '--set-priority') {
    setPriority = parseInt(args[++i]);
  } else if (arg === '--set-agent') {
    setAgent = parseInt(args[++i]);
  } else if (arg === '--set-group') {
    setGroup = parseInt(args[++i]);
  } else if (arg === '--set-type') {
    setType = args[++i];
  } else if (arg === '--set-tag') {
    setTag = args[++i];
  } else if (arg === '--private') {
    isPrivate = true;
  } else if (arg === '--body') {
    bodyText = args[++i];
  } else if (arg === '--set-title') {
    setTitle = args[++i];
  } else if (arg === '--set-article-status') {
    setArticleStatus = parseInt(args[++i]);
  } else if (!command) {
    command = arg;
  } else if (!targetInput) {
    targetInput = arg;
  } else if (!messageText) {
    messageText = arg;
  }
}

function showUsage() {
  console.error(`Usage: node query.mjs <command> [options]

Commands:
  tickets                          List recent tickets
  ticket <id>                      Get ticket details
  search <query>                   Search tickets (Freshdesk query syntax)
  conversations <id>               View ticket conversations
  investigate <id>                 Full ticket investigation (ticket + conversations + contact)
  reply <id> <message>             Reply to a ticket (visible to customer)
  note <id> <message>              Add internal note (not visible to customer)
  update <id>                      Update ticket properties
  contact <id|email>               Look up a contact
  contacts <query>                 Search contacts

Knowledge Base:
  kb-categories                    List all KB categories
  kb-folders <category_id>         List folders in a category
  kb-articles <folder_id>          List articles in a folder
  kb-article <article_id>          View a single article
  kb-search <term>                 Search KB articles
  kb-create <folder_id> <title>    Create an article in a folder
  kb-update <article_id>           Update an article

Options:
  --json                Output raw JSON
  --status <code>       Filter: 2=Open, 3=Pending, 4=Resolved, 5=Closed
  --priority <code>     Filter: 1=Low, 2=Medium, 3=High, 4=Urgent
  --page <n>            Page number (default: 1)
  --set-status <code>   Set ticket status
  --set-priority <code> Set ticket priority
  --set-agent <id>      Assign to agent ID
  --set-group <id>      Assign to group ID
  --set-type <type>     Set ticket type
  --set-tag <tag>       Set ticket tag (replaces existing)
  --body <text>         Article body (for kb-create/kb-update)
  --set-title <text>    Set article title (for kb-update)
  --set-article-status <1|2>  Article status: 1=draft, 2=published

Examples:
  node query.mjs tickets
  node query.mjs tickets --status 2 --priority 4
  node query.mjs ticket 12345
  node query.mjs search "status:2 AND priority:4"
  node query.mjs search "email:'user@example.com'"
  node query.mjs conversations 12345
  node query.mjs investigate 12345
  node query.mjs reply 12345 "Thanks for reaching out!"
  node query.mjs note 12345 "Internal: checked user account"
  node query.mjs update 12345 --set-status 3 --set-priority 2
  node query.mjs contact user@example.com
  node query.mjs contacts "john"

Knowledge Base:
  node query.mjs kb-categories
  node query.mjs kb-folders 12345
  node query.mjs kb-articles 67890
  node query.mjs kb-article 111
  node query.mjs kb-search "billing"
  node query.mjs kb-create 67890 "How to Reset Password" --body "<p>Steps to reset...</p>" --set-article-status 2
  node query.mjs kb-update 111 --set-title "Updated Title" --body "<p>New body</p>"

Configuration:
  Set FRESHDESK_TOKEN and FRESHDESK_DOMAIN in .claude/skills/freshdesk/.env
  See .env.example for details.`);
  process.exit(1);
}

if (!command) showUsage();

if (!API_TOKEN || !DOMAIN) {
  console.error('Error: FRESHDESK_TOKEN and FRESHDESK_DOMAIN must be set');
  console.error('Create .claude/skills/freshdesk/.env with your credentials');
  console.error('See .env.example for details');
  process.exit(1);
}

// Base64 encode for Basic auth
function toBase64(str) {
  return Buffer.from(str).toString('base64');
}

// API request helper
async function freshdeskApi(path, method = 'GET', body = null) {
  const url = `${DOMAIN}/api/v2${path}`;
  const options = {
    method,
    headers: {
      'Authorization': `Basic ${toBase64(`${API_TOKEN}:X`)}`,
      'Content-Type': 'application/json',
    },
  };

  if (body && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('Retry-After') || 60);
    console.error(`Rate limited. Retry after ${retryAfter} seconds.`);
    process.exit(1);
  }

  if (!response.ok) {
    const text = await response.text();
    let errorMessage = `API request failed: ${response.status} ${response.statusText}`;
    try {
      const errorData = JSON.parse(text);
      if (errorData.description) {
        errorMessage = errorData.description;
      }
      if (errorData.errors) {
        errorMessage += ': ' + JSON.stringify(errorData.errors);
      }
    } catch {
      if (text) errorMessage += `: ${text.slice(0, 200)}`;
    }
    throw new Error(errorMessage);
  }

  // Some endpoints return 204 No Content
  if (response.status === 204) return null;

  return await response.json();
}

// Strip HTML tags for plain text display
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Format date
function fmtDate(dateStr) {
  if (!dateStr) return 'N/A';
  const d = new Date(dateStr);
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

// Format ticket list
function formatTicketList(tickets) {
  if (!tickets || tickets.length === 0) return 'No tickets found.';

  const header = 'ID     | Status   | Priority | Subject                              | Requester';
  const sep =    '-------|----------|----------|--------------------------------------|------------------';
  const rows = tickets.map(t => {
    const id = String(t.id).padEnd(6);
    const status = (STATUS_MAP[t.status] || String(t.status)).padEnd(8);
    const priority = (PRIORITY_MAP[t.priority] || String(t.priority)).padEnd(8);
    const subject = (t.subject || '').slice(0, 36).padEnd(36);
    const requester = t.requester?.email || t.requester_id || '';
    return `${id} | ${status} | ${priority} | ${subject} | ${requester}`;
  });

  return [header, sep, ...rows].join('\n');
}

// Format ticket detail
function formatTicket(ticket) {
  if (!ticket) return 'Ticket not found.';

  let output = `Ticket #${ticket.id}\n`;
  output += `Subject: ${ticket.subject || 'N/A'}\n`;
  output += `Status: ${STATUS_MAP[ticket.status] || ticket.status} | Priority: ${PRIORITY_MAP[ticket.priority] || ticket.priority}`;
  if (ticket.type) output += ` | Type: ${ticket.type}`;
  output += '\n';

  if (ticket.requester) {
    output += `Requester: ${ticket.requester.email || 'N/A'}`;
    if (ticket.requester.name) output += ` (${ticket.requester.name})`;
    output += '\n';
  } else if (ticket.requester_id) {
    output += `Requester ID: ${ticket.requester_id}\n`;
  }

  if (ticket.responder_id) output += `Agent ID: ${ticket.responder_id}\n`;
  if (ticket.group_id) output += `Group ID: ${ticket.group_id}\n`;

  output += `Created: ${fmtDate(ticket.created_at)} | Updated: ${fmtDate(ticket.updated_at)}\n`;

  if (ticket.tags && ticket.tags.length > 0) {
    output += `Tags: ${ticket.tags.join(', ')}\n`;
  }

  if (ticket.description_text || ticket.description) {
    output += `\nDescription:\n  ${stripHtml(ticket.description_text || ticket.description).replace(/\n/g, '\n  ')}\n`;
  }

  return output;
}

// Format conversations
function formatConversations(conversations) {
  if (!conversations || conversations.length === 0) return 'No conversations found.';

  return conversations.map(c => {
    const isNote = c.private;
    const isReply = !isNote;
    const source = c.incoming ? 'Customer' : 'Agent';
    const type = isNote ? `Note (private)` : `Reply by ${source}`;
    const from = c.from_email || c.user_id || 'Unknown';
    const date = fmtDate(c.created_at);
    const body = stripHtml(c.body_text || c.body);

    let line = `--- ${type} (${date}) ---`;
    if (from) line += `\nFrom: ${from}`;
    line += `\n${body}`;
    return line;
  }).join('\n\n');
}

// Format contact
function formatContact(contact) {
  if (!contact) return 'Contact not found.';

  let output = `Contact #${contact.id}\n`;
  output += `Name: ${contact.name || 'N/A'}\n`;
  output += `Email: ${contact.email || 'N/A'}\n`;
  if (contact.phone) output += `Phone: ${contact.phone}\n`;
  if (contact.mobile) output += `Mobile: ${contact.mobile}\n`;
  if (contact.company_id) output += `Company ID: ${contact.company_id}\n`;
  if (contact.unique_external_id) output += `External ID: ${contact.unique_external_id}\n`;
  output += `Active: ${contact.active ? 'Yes' : 'No'}\n`;
  output += `Created: ${fmtDate(contact.created_at)}\n`;

  if (contact.custom_fields && Object.keys(contact.custom_fields).length > 0) {
    output += `Custom Fields:\n`;
    for (const [key, value] of Object.entries(contact.custom_fields)) {
      if (value != null) output += `  ${key}: ${value}\n`;
    }
  }

  return output;
}

// Format contact list
function formatContactList(contacts) {
  if (!contacts || contacts.length === 0) return 'No contacts found.';

  const header = 'ID       | Name                           | Email';
  const sep =    '---------|--------------------------------|---------------------------';
  const rows = contacts.map(c => {
    const id = String(c.id).padEnd(8);
    const name = (c.name || '').slice(0, 30).padEnd(30);
    const email = c.email || '';
    return `${id} | ${name} | ${email}`;
  });

  return [header, sep, ...rows].join('\n');
}

// Format investigation (ticket + conversations + contact)
function formatInvestigation(ticket, conversations, contact) {
  const civitaiUserId = contact?.unique_external_id?.match(/^civitai-(\d+)$/)?.[1] || null;

  let output = '=== TICKET INVESTIGATION ===\n\n';

  output += formatTicket(ticket);
  output += '\n';

  // Contact info
  if (contact) {
    output += '--- Contact Info ---\n';
    output += `Name: ${contact.name || 'N/A'}\n`;
    output += `Email: ${contact.email || 'N/A'}\n`;
    if (contact.unique_external_id) {
      output += `External ID: ${contact.unique_external_id}\n`;
      if (civitaiUserId) {
        output += `Civitai User ID: ${civitaiUserId}\n`;
      }
    }
    if (contact.phone) output += `Phone: ${contact.phone}\n`;
    output += `Active: ${contact.active ? 'Yes' : 'No'}\n`;
    output += '\n';
  }

  // Conversations
  output += '--- Conversation History ---\n';
  if (conversations && conversations.length > 0) {
    output += formatConversations(conversations);
  } else {
    output += 'No conversations found.';
  }
  output += '\n\n';

  // Quick reference
  output += '--- Quick Reference ---\n';
  output += `Civitai User ID: ${civitaiUserId || 'N/A'}\n`;
  output += `Email: ${contact?.email || ticket?.requester?.email || 'N/A'}\n`;

  if (ticket?.created_at) {
    const ageMs = Date.now() - new Date(ticket.created_at).getTime();
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    const ageHours = Math.floor((ageMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    output += `Ticket Age: ${ageDays}d ${ageHours}h\n`;
  }

  output += `Conversations: ${conversations?.length || 0}\n`;

  return output;
}

// KB status map
const ARTICLE_STATUS_MAP = { 1: 'Draft', 2: 'Published' };

// Format KB categories
function formatCategories(categories) {
  if (!categories || categories.length === 0) return 'No categories found.';

  const header = 'ID       | Name                                     | Description';
  const sep =    '---------|------------------------------------------|-----------------------------';
  const rows = categories.map(c => {
    const id = String(c.id).padEnd(8);
    const name = (c.name || '').slice(0, 40).padEnd(40);
    const desc = (c.description || '').slice(0, 27);
    return `${id} | ${name} | ${desc}`;
  });

  return [header, sep, ...rows].join('\n');
}

// Format KB folders
function formatFolders(folders) {
  if (!folders || folders.length === 0) return 'No folders found.';

  const header = 'ID       | Name                                     | Articles | Visibility';
  const sep =    '---------|------------------------------------------|----------|------------';
  const rows = folders.map(f => {
    const id = String(f.id).padEnd(8);
    const name = (f.name || '').slice(0, 40).padEnd(40);
    const articles = String(f.articles_count ?? '').padEnd(8);
    const visibility = f.visibility === 1 ? 'All' : f.visibility === 2 ? 'Logged in' : f.visibility === 3 ? 'Agents' : String(f.visibility ?? '');
    return `${id} | ${name} | ${articles} | ${visibility}`;
  });

  return [header, sep, ...rows].join('\n');
}

// Format KB article list
function formatArticleList(articles) {
  if (!articles || articles.length === 0) return 'No articles found.';

  const header = 'ID       | Status    | Title                                    | Updated';
  const sep =    '---------|-----------|------------------------------------------|------------------';
  const rows = articles.map(a => {
    const id = String(a.id).padEnd(8);
    const status = (ARTICLE_STATUS_MAP[a.status] || String(a.status)).padEnd(9);
    const title = (a.title || '').slice(0, 40).padEnd(40);
    const updated = fmtDate(a.updated_at);
    return `${id} | ${status} | ${title} | ${updated}`;
  });

  return [header, sep, ...rows].join('\n');
}

// Format single KB article
function formatArticle(article) {
  if (!article) return 'Article not found.';

  let output = `Article #${article.id}\n`;
  output += `Title: ${article.title || 'N/A'}\n`;
  output += `Status: ${ARTICLE_STATUS_MAP[article.status] || article.status}`;
  if (article.folder_id) output += ` | Folder ID: ${article.folder_id}`;
  if (article.category_id) output += ` | Category ID: ${article.category_id}`;
  output += '\n';

  output += `Created: ${fmtDate(article.created_at)} | Updated: ${fmtDate(article.updated_at)}\n`;

  if (article.tags && article.tags.length > 0) {
    output += `Tags: ${article.tags.join(', ')}\n`;
  }

  if (article.description_text || article.description) {
    output += `\nBody:\n  ${stripHtml(article.description_text || article.description).replace(/\n/g, '\n  ')}\n`;
  }

  return output;
}

async function main() {
  console.error(`Using Freshdesk: ${DOMAIN}`);

  switch (command) {
    case 'tickets': {
      let path = '/tickets?per_page=30&include=requester';
      if (page > 1) path += `&page=${page}`;

      // Build filter query if needed
      const filters = [];
      if (statusFilter) filters.push(`"status:${statusFilter}"`);
      if (priorityFilter) filters.push(`"priority:${priorityFilter}"`);

      let data;
      if (filters.length > 0) {
        // Use search API for filtered queries
        const query = filters.join(' AND ');
        data = await freshdeskApi(`/search/tickets?query=${encodeURIComponent(query)}`);
        data = data.results || data;
      } else {
        data = await freshdeskApi(path);
      }

      if (jsonOutput) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatTicketList(data));
        if (Array.isArray(data) && data.length === 30) {
          console.log(`\n(Page ${page} - use --page ${page + 1} for more)`);
        }
      }
      break;
    }

    case 'ticket': {
      if (!targetInput) {
        console.error('Error: Ticket ID required');
        showUsage();
      }
      const ticket = await freshdeskApi(`/tickets/${targetInput}?include=requester`);

      if (jsonOutput) {
        console.log(JSON.stringify(ticket, null, 2));
      } else {
        console.log(formatTicket(ticket));
      }
      break;
    }

    case 'search': {
      if (!targetInput) {
        console.error('Error: Search query required');
        console.error('Example: node query.mjs search "status:2 AND priority:4"');
        showUsage();
      }

      // Ensure query is properly wrapped in double quotes for Freshdesk API
      let query = targetInput;
      if (!query.startsWith('"') || !query.endsWith('"')) {
        query = `"${query.replace(/^"|"$/g, '')}"`;
      }

      const data = await freshdeskApi(`/search/tickets?query=${encodeURIComponent(query)}`);
      const results = data.results || data;

      if (jsonOutput) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatTicketList(results));
        if (data.total) {
          console.log(`\nTotal results: ${data.total}`);
        }
      }
      break;
    }

    case 'conversations': {
      if (!targetInput) {
        console.error('Error: Ticket ID required');
        showUsage();
      }

      const conversations = await freshdeskApi(`/tickets/${targetInput}/conversations`);

      if (jsonOutput) {
        console.log(JSON.stringify(conversations, null, 2));
      } else {
        console.log(`Conversations for Ticket #${targetInput}:\n`);
        console.log(formatConversations(conversations));
      }
      break;
    }

    case 'reply': {
      if (!targetInput || !messageText) {
        console.error('Error: Ticket ID and message required');
        console.error('Example: node query.mjs reply 12345 "Thanks for reaching out!"');
        showUsage();
      }

      const reply = await freshdeskApi(`/tickets/${targetInput}/reply`, 'POST', {
        body: messageText,
      });

      if (jsonOutput) {
        console.log(JSON.stringify(reply, null, 2));
      } else {
        console.log(`Reply sent to Ticket #${targetInput}`);
        if (reply) console.log(`Conversation ID: ${reply.id}`);
      }
      break;
    }

    case 'note': {
      if (!targetInput || !messageText) {
        console.error('Error: Ticket ID and message required');
        console.error('Example: node query.mjs note 12345 "Internal note about this ticket"');
        showUsage();
      }

      const note = await freshdeskApi(`/tickets/${targetInput}/notes`, 'POST', {
        body: messageText,
        private: isPrivate,
      });

      if (jsonOutput) {
        console.log(JSON.stringify(note, null, 2));
      } else {
        console.log(`${isPrivate ? 'Private' : 'Public'} note added to Ticket #${targetInput}`);
        if (note) console.log(`Note ID: ${note.id}`);
      }
      break;
    }

    case 'update': {
      if (!targetInput) {
        console.error('Error: Ticket ID required');
        showUsage();
      }

      const updates = {};
      if (setStatus != null) updates.status = setStatus;
      if (setPriority != null) updates.priority = setPriority;
      if (setAgent != null) updates.responder_id = setAgent;
      if (setGroup != null) updates.group_id = setGroup;
      if (setType != null) updates.type = setType;
      if (setTag != null) updates.tags = [setTag];

      if (Object.keys(updates).length === 0) {
        console.error('Error: No updates specified');
        console.error('Use --set-status, --set-priority, --set-agent, --set-group, --set-type, or --set-tag');
        process.exit(1);
      }

      const updated = await freshdeskApi(`/tickets/${targetInput}`, 'PUT', updates);

      if (jsonOutput) {
        console.log(JSON.stringify(updated, null, 2));
      } else {
        console.log(`Ticket #${targetInput} updated:`);
        if (setStatus != null) console.log(`  Status: ${STATUS_MAP[setStatus] || setStatus}`);
        if (setPriority != null) console.log(`  Priority: ${PRIORITY_MAP[setPriority] || setPriority}`);
        if (setAgent != null) console.log(`  Agent: ${setAgent}`);
        if (setGroup != null) console.log(`  Group: ${setGroup}`);
        if (setType != null) console.log(`  Type: ${setType}`);
        if (setTag != null) console.log(`  Tags set to: ${setTag}`);
      }
      break;
    }

    case 'contact': {
      if (!targetInput) {
        console.error('Error: Contact ID or email required');
        showUsage();
      }

      let contact;
      const isEmail = targetInput.includes('@');
      const isId = /^\d+$/.test(targetInput);

      if (isId) {
        contact = await freshdeskApi(`/contacts/${targetInput}`);
      } else if (isEmail) {
        // Search by email (escape single quotes in input)
        const safeInput = targetInput.replace(/'/g, "\\'");
        const data = await freshdeskApi(`/search/contacts?query="email:'${safeInput}'"`);
        const results = data.results || data;
        contact = results && results.length > 0 ? results[0] : null;
      } else {
        // Try as unique_external_id
        const data = await freshdeskApi(`/contacts/autocomplete?term=${encodeURIComponent(targetInput)}`);
        contact = data && data.length > 0 ? data[0] : null;
      }

      if (jsonOutput) {
        console.log(JSON.stringify(contact, null, 2));
      } else {
        console.log(formatContact(contact));
      }
      break;
    }

    case 'investigate': {
      if (!targetInput) {
        console.error('Error: Ticket ID required');
        showUsage();
      }

      // Fetch ticket and conversations in parallel
      const [ticket, conversations] = await Promise.all([
        freshdeskApi(`/tickets/${targetInput}?include=requester`),
        freshdeskApi(`/tickets/${targetInput}/conversations`),
      ]);

      // Fetch contact (best-effort, sequential since we need requester_id from ticket)
      let contact = null;
      if (ticket?.requester_id) {
        try {
          contact = await freshdeskApi(`/contacts/${ticket.requester_id}`);
        } catch {
          // Contact lookup is best-effort
        }
      }

      if (jsonOutput) {
        console.log(JSON.stringify({ ticket, conversations, contact }, null, 2));
      } else {
        console.log(formatInvestigation(ticket, conversations, contact));
      }
      break;
    }

    case 'contacts': {
      if (!targetInput) {
        console.error('Error: Search query required');
        showUsage();
      }

      // Try search API first (escape single quotes in input)
      const safeQuery = targetInput.replace(/'/g, "\\'");
      let data;
      try {
        data = await freshdeskApi(
          `/search/contacts?query="name:'${safeQuery}' OR email:'${safeQuery}'"`
        );
        data = data.results || data;
      } catch {
        // Fall back to autocomplete
        data = await freshdeskApi(`/contacts/autocomplete?term=${encodeURIComponent(targetInput)}`);
      }

      if (jsonOutput) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatContactList(data));
      }
      break;
    }

    // Knowledge Base commands

    case 'kb-categories': {
      const data = await freshdeskApi('/solutions/categories');

      if (jsonOutput) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatCategories(data));
      }
      break;
    }

    case 'kb-folders': {
      if (!targetInput) {
        console.error('Error: Category ID required');
        showUsage();
      }

      const data = await freshdeskApi(`/solutions/categories/${targetInput}/folders`);

      if (jsonOutput) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`Folders in Category #${targetInput}:\n`);
        console.log(formatFolders(data));
      }
      break;
    }

    case 'kb-articles': {
      if (!targetInput) {
        console.error('Error: Folder ID required');
        showUsage();
      }

      const data = await freshdeskApi(`/solutions/folders/${targetInput}/articles`);

      if (jsonOutput) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`Articles in Folder #${targetInput}:\n`);
        console.log(formatArticleList(data));
      }
      break;
    }

    case 'kb-article': {
      if (!targetInput) {
        console.error('Error: Article ID required');
        showUsage();
      }

      const article = await freshdeskApi(`/solutions/articles/${targetInput}`);

      if (jsonOutput) {
        console.log(JSON.stringify(article, null, 2));
      } else {
        console.log(formatArticle(article));
      }
      break;
    }

    case 'kb-search': {
      if (!targetInput) {
        console.error('Error: Search term required');
        showUsage();
      }

      const data = await freshdeskApi(`/search/solutions?term=${encodeURIComponent(targetInput)}`);
      const results = data.results || data;

      if (jsonOutput) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatArticleList(results));
        if (data.total) {
          console.log(`\nTotal results: ${data.total}`);
        }
      }
      break;
    }

    case 'kb-create': {
      if (!targetInput) {
        console.error('Error: Folder ID required');
        showUsage();
      }
      if (!messageText) {
        console.error('Error: Article title required');
        console.error('Example: node query.mjs kb-create 67890 "Article Title" --body "<p>Content</p>"');
        showUsage();
      }

      const articleData = {
        title: messageText,
        description: bodyText || '',
        status: setArticleStatus || 1,
      };

      const created = await freshdeskApi(`/solutions/folders/${targetInput}/articles`, 'POST', articleData);

      if (jsonOutput) {
        console.log(JSON.stringify(created, null, 2));
      } else {
        console.log(`Article created in Folder #${targetInput}`);
        if (created) {
          console.log(`Article ID: ${created.id}`);
          console.log(`Title: ${created.title}`);
          console.log(`Status: ${ARTICLE_STATUS_MAP[created.status] || created.status}`);
        }
      }
      break;
    }

    case 'kb-update': {
      if (!targetInput) {
        console.error('Error: Article ID required');
        showUsage();
      }

      const updates = {};
      if (setTitle != null) updates.title = setTitle;
      if (bodyText != null) updates.description = bodyText;
      if (setArticleStatus != null) updates.status = setArticleStatus;

      if (Object.keys(updates).length === 0) {
        console.error('Error: No updates specified');
        console.error('Use --set-title, --body, or --set-article-status');
        process.exit(1);
      }

      const updated = await freshdeskApi(`/solutions/articles/${targetInput}`, 'PUT', updates);

      if (jsonOutput) {
        console.log(JSON.stringify(updated, null, 2));
      } else {
        console.log(`Article #${targetInput} updated:`);
        if (setTitle != null) console.log(`  Title: ${setTitle}`);
        if (bodyText != null) console.log(`  Body: updated`);
        if (setArticleStatus != null) console.log(`  Status: ${ARTICLE_STATUS_MAP[setArticleStatus] || setArticleStatus}`);
      }
      break;
    }

    case 'ticket-fields': {
      const data = await freshdeskApi('/ticket_fields');
      if (jsonOutput) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        for (const field of data) {
          console.log(`${field.name} (${field.label_for_agents || field.label}) [${field.field_type}]`);
          if (field.choices && Object.keys(field.choices).length > 0) {
            for (const choice of Object.values(field.choices)) {
              console.log(`  - ${choice}`);
            }
          }
        }
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      showUsage();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
