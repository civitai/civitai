import type { ToolDefinitionJson } from '@openrouter/sdk/models';
import { Prisma } from '@prisma/client';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { freshdeskCaller } from '~/server/http/freshdesk/freshdesk.caller';
import type { FreshdeskWebhookPhase } from '~/server/http/freshdesk/freshdesk.schema';
import { agentLog, getDebugContext } from './freshdesk-debug';
import {
  investigateUserAccount,
  investigateCosmetics,
  investigateContent,
  investigateSubscription,
  investigateModeration,
} from './freshdesk-investigation-tools';

// --- Tool definitions ---

const getTicketTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'get_ticket',
    description: 'Fetch a Freshdesk ticket by ID, including its description.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'number', description: 'The Freshdesk ticket ID' },
      },
      required: ['ticket_id'],
    },
  },
};

const getConversationsTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'get_conversations',
    description: 'Get the full conversation history for a Freshdesk ticket.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'number', description: 'The Freshdesk ticket ID' },
      },
      required: ['ticket_id'],
    },
  },
};

const getContactTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'get_contact',
    description: 'Look up a Freshdesk contact by their contact ID.',
    parameters: {
      type: 'object',
      properties: {
        contact_id: { type: 'number', description: 'The Freshdesk contact ID' },
      },
      required: ['contact_id'],
    },
  },
};

const addNoteTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'add_note',
    description:
      'Add a private internal note to a Freshdesk ticket. This is NOT visible to the customer.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'number', description: 'The Freshdesk ticket ID' },
        body: { type: 'string', description: 'The note content (HTML supported)' },
      },
      required: ['ticket_id', 'body'],
    },
  },
};

const updateTicketTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'update_ticket',
    description:
      'Update ticket properties like tags or priority. Do NOT set status — never change ticket status. Only include the fields you want to change.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'number', description: 'The Freshdesk ticket ID' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Update the ticket's process tags. Only add from this exact list: 'AI Triaged' (triage phase), 'AI Investigated' (investigation phase), 'Add to KB' (mark for KB creation), 'KB Updated' (KB phase complete). Always preserve ALL existing tags. Never create new tags not in this list.",
        },
        priority: {
          type: 'number',
          description: 'Ticket priority: 1=Low, 2=Medium, 3=High, 4=Urgent',
        },
        custom_fields: {
          type: 'object',
          description:
            'Custom field values to set. Use cf_feature to classify the ticket feature area.',
          properties: {
            cf_feature: {
              type: 'string',
              description:
                'The feature area. One of: Account Login, Email Change, Image Generator, LoRA Trainer, Account Restriction or Banned Account, Content Related Issue, Moderation Decision, Cosmetic Shop, Buzz (Purchase), Buzz (Receiving), Billing or Membership, Bounty System, Civitai Link, Civitai Vault, User Report, API, Other/Misc.',
            },
          },
        },
      },
      required: ['ticket_id'],
    },
  },
};

const searchKBTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'search_kb',
    description: 'Search the Freshdesk knowledge base for articles matching a keyword/phrase.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term for KB articles' },
      },
      required: ['query'],
    },
  },
};

const getKBArticleTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'get_kb_article',
    description: 'Read the full content of a knowledge base article by its ID.',
    parameters: {
      type: 'object',
      properties: {
        article_id: { type: 'number', description: 'The KB article ID' },
      },
      required: ['article_id'],
    },
  },
};

const listKBCategoriesTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'list_kb_categories',
    description: 'List all knowledge base categories.',
    parameters: { type: 'object', properties: {} },
  },
};

const listKBFoldersTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'list_kb_folders',
    description: 'List all folders within a knowledge base category.',
    parameters: {
      type: 'object',
      properties: {
        category_id: { type: 'number', description: 'The KB category ID' },
      },
      required: ['category_id'],
    },
  },
};

const listKBArticlesTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'list_kb_articles',
    description: 'List all articles within a knowledge base folder.',
    parameters: {
      type: 'object',
      properties: {
        folder_id: { type: 'number', description: 'The KB folder ID' },
      },
      required: ['folder_id'],
    },
  },
};

const createKBArticleTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'create_kb_article',
    description: 'Create a new knowledge base article in a specific folder.',
    parameters: {
      type: 'object',
      properties: {
        folder_id: { type: 'number', description: 'The KB folder ID to create the article in' },
        title: { type: 'string', description: 'Article title' },
        description: { type: 'string', description: 'Article body content (HTML)' },
        status: {
          type: 'number',
          description: 'Article status: 1=Draft, 2=Published',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for the article',
        },
      },
      required: ['folder_id', 'title', 'description', 'status'],
    },
  },
};

const updateKBArticleTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'update_kb_article',
    description: 'Update an existing knowledge base article.',
    parameters: {
      type: 'object',
      properties: {
        article_id: { type: 'number', description: 'The KB article ID to update' },
        title: { type: 'string', description: 'New article title' },
        description: { type: 'string', description: 'New article body content (HTML)' },
        status: { type: 'number', description: 'Article status: 1=Draft, 2=Published' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for the article' },
      },
      required: ['article_id'],
    },
  },
};

const queryDatabaseTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'query_database',
    description:
      'Execute a read-only SQL query against the Civitai database. Use this to verify facts, look up user info, check system data, etc. Only SELECT queries are allowed. Queries have a 30 second timeout.',
    parameters: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description:
            'A read-only SQL SELECT query. Must start with SELECT. Keep results small — use LIMIT.',
        },
      },
      required: ['sql'],
    },
  },
};

// --- Investigation tools ---

const investigateUserAccountTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'investigate_user_account',
    description:
      'Get a comprehensive overview of a Civitai user account including profile, status, active strikes, restrictions, and stats. Use this as a starting point for any investigation.',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: 'The Civitai user ID' },
      },
      required: ['user_id'],
    },
  },
};

const investigateCosmeticsTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'investigate_cosmetics',
    description:
      'Get all cosmetics owned by a user, including badges, decorations, shop purchases, and challenge wins. Use for tickets about missing rewards, cosmetic issues, or contest prizes.',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: 'The Civitai user ID' },
      },
      required: ['user_id'],
    },
  },
};

const investigateContentTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'investigate_content',
    description:
      "Get a user's recent models, images, and posts with their moderation status, plus any reports against their content. Use for tickets about content removal, visibility issues, or TOS violations.",
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: 'The Civitai user ID' },
      },
      required: ['user_id'],
    },
  },
};

const investigateSubscriptionTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'investigate_subscription',
    description:
      "Get a user's subscription history, one-time purchases, and buzz withdrawal requests. Use for tickets about billing, membership, payments, or buzz cashout issues.",
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: 'The Civitai user ID' },
      },
      required: ['user_id'],
    },
  },
};

const investigateModerationTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'investigate_moderation',
    description:
      "Get a user's full moderation history including all strikes (active/expired/voided), restrictions, and reports (both filed and received). Use for tickets about bans, mutes, content removal, or account restrictions.",
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: 'The Civitai user ID' },
      },
      required: ['user_id'],
    },
  },
};

// --- Tool execution ---

const DB_QUERY_TIMEOUT_MS = 30_000;

async function executeQueryDatabase(sql: string): Promise<string> {
  // Safety: only allow SELECT queries
  const trimmed = sql.trim().toUpperCase();
  if (!trimmed.startsWith('SELECT')) {
    return 'Error: Only SELECT queries are allowed.';
  }

  try {
    const results = await dbRead.$queryRaw(Prisma.raw(sql));
    const rows = results as Record<string, unknown>[];
    if (rows.length === 0) return 'No results found.';
    // Limit output size
    const truncated = rows.slice(0, 50);
    return JSON.stringify(truncated, null, 2);
  } catch (err) {
    return `Query error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Helper to extract data from HttpCaller response (handles discriminated union)
function formatResponse(res: { ok: boolean; status: number; data?: unknown; message?: string }) {
  if ('data' in res && res.data !== undefined) {
    return JSON.stringify(res.data);
  }
  return JSON.stringify({ error: 'message' in res ? res.message : `Status ${res.status}` });
}

const MUTATION_TOOLS = new Set([
  'add_note',
  'update_ticket',
  'create_kb_article',
  'update_kb_article',
]);

export async function executeToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const ctx = getDebugContext();

  // Dry-run: intercept mutation tools, return fake success
  if (ctx?.dryRun && MUTATION_TOOLS.has(name)) {
    agentLog(`DRY RUN INTERCEPTED: ${name}`, args);
    return JSON.stringify({ success: true, dry_run: true, tool: name, args });
  }

  agentLog(`TOOL CALL: ${name}`, args);

  try {
    let result: string;
    switch (name) {
      case 'get_ticket': {
        const res = await freshdeskCaller.getTicket(args.ticket_id as number);
        result = formatResponse(res);
        break;
      }
      case 'get_conversations': {
        const res = await freshdeskCaller.getConversations(args.ticket_id as number);
        result = formatResponse(res);
        break;
      }
      case 'get_contact': {
        const res = await freshdeskCaller.getContact(args.contact_id as number);
        result = formatResponse(res);
        break;
      }
      case 'add_note': {
        const agentId = env.FRESHDESK_AGENT_ID ? Number(env.FRESHDESK_AGENT_ID) : undefined;
        const res = await freshdeskCaller.addNote(
          args.ticket_id as number,
          args.body as string,
          true,
          agentId
        );
        result = formatResponse(res);
        break;
      }
      case 'update_ticket': {
        const { ticket_id, ...data } = args;
        const res = await freshdeskCaller.updateTicket(ticket_id as number, data);
        result = formatResponse(res);
        break;
      }
      case 'search_kb': {
        const res = await freshdeskCaller.searchKB(args.query as string);
        result = formatResponse(res);
        break;
      }
      case 'get_kb_article': {
        const res = await freshdeskCaller.getArticle(args.article_id as number);
        result = formatResponse(res);
        break;
      }
      case 'list_kb_categories': {
        const res = await freshdeskCaller.listCategories();
        result = formatResponse(res);
        break;
      }
      case 'list_kb_folders': {
        const res = await freshdeskCaller.listFolders(args.category_id as number);
        result = formatResponse(res);
        break;
      }
      case 'list_kb_articles': {
        const res = await freshdeskCaller.listArticles(args.folder_id as number);
        result = formatResponse(res);
        break;
      }
      case 'create_kb_article': {
        const { folder_id, ...article } = args;
        const res = await freshdeskCaller.createArticle(folder_id as number, {
          ...(article as { title: string; description: string; status: number; tags?: string[] }),
          status: 2, // Always publish immediately
        });
        result = formatResponse(res);
        break;
      }
      case 'update_kb_article': {
        const { article_id, ...article } = args;
        const res = await freshdeskCaller.updateArticle(article_id as number, {
          ...article,
          status: 2, // Always publish immediately
        });
        result = formatResponse(res);
        break;
      }
      case 'investigate_user_account':
      case 'investigate_cosmetics':
      case 'investigate_content':
      case 'investigate_subscription':
      case 'investigate_moderation': {
        const userId = Number(args.user_id);
        if (!Number.isInteger(userId) || userId <= 0) {
          result = JSON.stringify({ error: 'user_id must be a positive integer' });
          break;
        }
        const investigationFns = {
          investigate_user_account: investigateUserAccount,
          investigate_cosmetics: investigateCosmetics,
          investigate_content: investigateContent,
          investigate_subscription: investigateSubscription,
          investigate_moderation: investigateModeration,
        } as const;
        result = await investigationFns[name](userId);
        break;
      }
      case 'query_database': {
        result = await Promise.race([
          executeQueryDatabase(args.sql as string),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('Query timed out after 30s')), DB_QUERY_TIMEOUT_MS)
          ),
        ]);
        break;
      }
      default:
        result = `Unknown tool: ${name}`;
    }

    agentLog(`TOOL RESULT: ${name}`, result);
    return result;
  } catch (err) {
    const errMsg = `Tool execution error: ${err instanceof Error ? err.message : String(err)}`;
    agentLog(`TOOL ERROR: ${name}`, errMsg);
    return errMsg;
  }
}

// --- Tool sets per phase ---

const COMMON_TOOLS = [
  getTicketTool,
  getConversationsTool,
  getContactTool,
  addNoteTool,
  updateTicketTool,
  searchKBTool,
  getKBArticleTool,
];

const KB_TOOLS = [
  listKBCategoriesTool,
  listKBFoldersTool,
  listKBArticlesTool,
  createKBArticleTool,
  updateKBArticleTool,
];

const INVESTIGATION_TOOLS = [
  investigateUserAccountTool,
  investigateCosmeticsTool,
  investigateContentTool,
  investigateSubscriptionTool,
  investigateModerationTool,
];

export function getToolsForPhase(phase: FreshdeskWebhookPhase): ToolDefinitionJson[] {
  switch (phase) {
    case 'kb-article':
      return [...COMMON_TOOLS, ...KB_TOOLS, queryDatabaseTool];
    case 'triage':
      return [...COMMON_TOOLS];
    case 'investigation':
      return [...COMMON_TOOLS, ...INVESTIGATION_TOOLS, queryDatabaseTool];
  }
}
