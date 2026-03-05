import type { ToolDefinitionJson } from '@openrouter/sdk/models';
import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { freshdeskCaller } from '~/server/http/freshdesk/freshdesk.caller';
import type { FreshdeskWebhookPhase } from '~/server/http/freshdesk/freshdesk.schema';

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
      'Update ticket properties like tags, priority, or status. Only include the fields you want to change.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'number', description: 'The Freshdesk ticket ID' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replace all tags on the ticket with this list',
        },
        priority: {
          type: 'number',
          description: 'Ticket priority: 1=Low, 2=Medium, 3=High, 4=Urgent',
        },
        status: {
          type: 'number',
          description: 'Ticket status: 2=Open, 3=Pending, 4=Resolved, 5=Closed',
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
  return JSON.stringify({ error: `message` in res ? res.message : `Status ${res.status}` });
}

export async function executeToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    switch (name) {
      case 'get_ticket': {
        const res = await freshdeskCaller.getTicket(args.ticket_id as number);
        return formatResponse(res);
      }
      case 'get_conversations': {
        const res = await freshdeskCaller.getConversations(args.ticket_id as number);
        return formatResponse(res);
      }
      case 'get_contact': {
        const res = await freshdeskCaller.getContact(args.contact_id as number);
        return formatResponse(res);
      }
      case 'add_note': {
        const res = await freshdeskCaller.addNote(args.ticket_id as number, args.body as string);
        return formatResponse(res);
      }
      case 'update_ticket': {
        const { ticket_id, ...data } = args;
        const res = await freshdeskCaller.updateTicket(ticket_id as number, data);
        return formatResponse(res);
      }
      case 'search_kb': {
        const res = await freshdeskCaller.searchKB(args.query as string);
        return formatResponse(res);
      }
      case 'get_kb_article': {
        const res = await freshdeskCaller.getArticle(args.article_id as number);
        return formatResponse(res);
      }
      case 'list_kb_categories': {
        const res = await freshdeskCaller.listCategories();
        return formatResponse(res);
      }
      case 'list_kb_folders': {
        const res = await freshdeskCaller.listFolders(args.category_id as number);
        return formatResponse(res);
      }
      case 'list_kb_articles': {
        const res = await freshdeskCaller.listArticles(args.folder_id as number);
        return formatResponse(res);
      }
      case 'create_kb_article': {
        const { folder_id, ...article } = args;
        const res = await freshdeskCaller.createArticle(
          folder_id as number,
          article as { title: string; description: string; status: number; tags?: string[] }
        );
        return formatResponse(res);
      }
      case 'update_kb_article': {
        const { article_id, ...article } = args;
        const res = await freshdeskCaller.updateArticle(article_id as number, article);
        return formatResponse(res);
      }
      case 'query_database': {
        const result = await Promise.race([
          executeQueryDatabase(args.sql as string),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('Query timed out after 30s')), DB_QUERY_TIMEOUT_MS)
          ),
        ]);
        return result;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool execution error: ${err instanceof Error ? err.message : String(err)}`;
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

export function getToolsForPhase(phase: FreshdeskWebhookPhase): ToolDefinitionJson[] {
  switch (phase) {
    case 'kb-article':
      return [...COMMON_TOOLS, ...KB_TOOLS, queryDatabaseTool];
    case 'triage':
      return [...COMMON_TOOLS];
    case 'investigation':
      return [...COMMON_TOOLS, queryDatabaseTool];
  }
}
