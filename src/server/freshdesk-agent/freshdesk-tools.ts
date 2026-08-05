import type { ToolDefinitionJson } from '@openrouter/sdk/models';
import { env } from '~/env/server';
import { queryWithTimeout } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import { freshdeskCaller } from '~/server/http/freshdesk/freshdesk.caller';
import type { FreshdeskWebhookPhase } from '~/server/http/freshdesk/freshdesk.schema';
import { agentLog, getDebugContext } from './freshdesk-debug';
import { FRESHDESK_QUERY_TABLES, checkQueryScope } from './freshdesk-query-scope';
import {
  investigateUserAccount,
  investigateCosmetics,
  investigateContent,
  investigateSubscription,
  investigateModeration,
  checkSiteStatus,
  investigateCryptoPayments,
} from './freshdesk-investigation-tools';

/**
 * Ceiling for a single `query_database` statement. Applied as a Postgres
 * `statement_timeout` inside the query's own transaction, so the database
 * cancels the backend and releases the pooled connection. The tool
 * description states this as a guarantee, so it has to be the real mechanism.
 */
const DB_QUERY_TIMEOUT_MS = 30_000;
const DB_QUERY_TIMEOUT_SECONDS = DB_QUERY_TIMEOUT_MS / 1000;

/** Rows `query_database` will hand back to the model. */
const MAX_RESULT_ROWS = 50;

/**
 * Rows actually asked of the database: one more than we return, so a full page
 * is distinguishable from a truncated one. Slicing a buffered array cannot make
 * that distinction, which is why the old code could not say whether "50 rows"
 * meant "50 rows existed" or "we threw the rest away".
 */
const ROW_FETCH_LIMIT = MAX_RESULT_ROWS + 1;

/**
 * Alias for the bounding subquery. Postgres requires a derived table be named,
 * and the name is unlikely enough to collide with a model-chosen alias — though
 * a collision would be harmless anyway: an inner alias lives at its own query
 * level, verified against Postgres 18.
 */
const ROW_BOUND_ALIAS = '__civitai_row_bound';

/**
 * Wrap the model's statement so the ROW BOUND is the database's to enforce,
 * matching the other two bounds (`checkQueryScope` for relations, `SET LOCAL
 * statement_timeout` for time).
 *
 * Why this is not a `rows.slice(0, 50)`: `queryWithTimeout` goes through
 * node-postgres `client.query()`, which is NOT streaming — it accumulates every
 * row of the result into the Node heap before the promise resolves. A
 * model-written `SELECT * FROM "User"` with no LIMIT therefore materialised the
 * whole table in-process and only then discarded all but 50 rows, so the 50 was
 * a bound on the model's context window, not on this process's memory. The tool
 * description promises the bounds are "enforced by the server, not by
 * convention"; an outer LIMIT is what makes that true of the row count too.
 *
 * Semantics of the wrap were verified against a real Postgres rather than
 * reasoned about — `ORDER BY` (including on an unprojected column, by ordinal,
 * and across a `UNION`), `UNION`/`UNION ALL`, `DISTINCT ON`, `GROUP BY`/
 * `HAVING`, window functions, and an inner `LIMIT`/`OFFSET` all survive it, and
 * duplicate output column names in the inner statement are legal in a derived
 * table (`SELECT * FROM (SELECT 1 AS a, 2 AS a) x` is accepted, both columns
 * preserved). The plan is `Limit -> ...`, so the scan really stops early rather
 * than filtering afterwards.
 *
 * The trailing `;` that `checkQueryScope` permits has to go first, or the wrap
 * is a syntax error.
 */
function boundRowCount(sql: string): string {
  const trimmed = sql.trim();
  const withoutTerminator = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed;
  return `SELECT * FROM (${withoutTerminator}) ${ROW_BOUND_ALIAS} LIMIT ${ROW_FETCH_LIMIT}`;
}

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

const closeTicketAsSpamTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'close_ticket_as_spam',
    description:
      'Mark a ticket as spam and close it. ONLY use this in triage when the ticket is clearly spam, phishing, an unrelated marketing pitch, a scam, automated junk, or otherwise not a legitimate support request. When in doubt, do NOT use this — let a human decide. This is the only situation where the AI is permitted to change ticket status.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'number', description: 'The Freshdesk ticket ID' },
        reason: {
          type: 'string',
          description:
            'Short justification for the spam classification (e.g., "promotional email unrelated to Civitai", "phishing attempt", "automated bounce/auto-reply").',
        },
      },
      required: ['ticket_id', 'reason'],
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
    description: [
      'Execute a SELECT query against the Civitai database. Use this to verify facts, look up user info, or check system data when the purpose-built investigation tools do not cover what you need.',
      'The following are enforced by the server, not by convention — a query that breaks any of them is rejected, cancelled, or truncated, so write to them up front:',
      `- It can only read these tables: ${FRESHDESK_QUERY_TABLES.map((t) => `"${t}"`).join(', ')}.`,
      '- It runs inside a read-only transaction, so nothing can be written.',
      `- The database cancels the statement after ${DB_QUERY_TIMEOUT_SECONDS} seconds. Always use LIMIT and filter on indexed columns.`,
      '- One statement only. No comments, no CTEs (WITH), no schema prefixes, no table functions.',
      '- Reference tables by their exact double-quoted name, e.g. FROM "User".',
      "- FROM-inside-a-function-call is not supported: use date_part('epoch', col) rather than EXTRACT(EPOCH FROM col), and substr(...) rather than SUBSTRING(x FROM 1).",
      `- At most ${MAX_RESULT_ROWS} rows come back. The server wraps the statement in its own outer LIMIT, so this holds whether or not you wrote a LIMIT, and the result says so explicitly when it truncated. Your own LIMIT is still worth writing — the outer one caps what is returned, not how much the database has to sort or aggregate first.`,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description:
            'A single SELECT statement over the allowed tables. Must start with SELECT. Keep results small — use LIMIT.',
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

const checkSiteStatusTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'check_site_status',
    description:
      "Check current platform health and recent incidents. Use this to determine if the user's issue might be caused by a known platform problem (e.g., generator down, database issues). No parameters needed.",
    parameters: { type: 'object', properties: {} },
  },
};

const investigateCryptoPaymentsTool: ToolDefinitionJson = {
  type: 'function',
  function: {
    name: 'investigate_crypto_payments',
    description:
      "Get a user's crypto payment history including wallet addresses, recent deposits with status/amounts/buzz credited, and live payment status from NowPayments API for stuck transactions. Use for tickets about crypto payments not going through, buzz not received after crypto payment, or payments stuck in confirming status.",
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

/** Postgres `query_canceled` — what `statement_timeout` raises. */
const PG_QUERY_CANCELED = '57014';

async function executeQueryDatabase(sql: string): Promise<string> {
  // Safety: only allow SELECT queries
  const trimmed = sql.trim().toUpperCase();
  if (!trimmed.startsWith('SELECT')) {
    return 'Error: Only SELECT queries are allowed.';
  }

  // Bound WHICH relations the statement can reach before it touches a
  // connection. This reads the model's ORIGINAL text — `boundRowCount` below
  // rewrites the statement, and a scope check run against the rewrite would be
  // auditing our own wrapper rather than the model's query.
  const scope = checkQueryScope(sql);
  if (!scope.ok) return scope.error;

  try {
    // `queryWithTimeout` wraps the statement in BEGIN READ ONLY + SET LOCAL
    // statement_timeout, so both of those bounds are the database's to enforce.
    // A `Promise.race` here would only abandon the promise — the backend would
    // keep running and keep holding its pooled connection. `boundRowCount`
    // makes the row bound the database's too: node-postgres buffers the whole
    // result set into the heap, so a bound applied after the await is not a
    // bound on this process at all.
    const { rows } = await queryWithTimeout<Record<string, unknown>>(
      pgDbRead,
      DB_QUERY_TIMEOUT_MS,
      boundRowCount(sql)
    );
    if (rows.length === 0) return 'No results found.';
    if (rows.length > MAX_RESULT_ROWS) {
      const shown = JSON.stringify(rows.slice(0, MAX_RESULT_ROWS), null, 2);
      return `${shown}\n\nTruncated: more than ${MAX_RESULT_ROWS} rows matched and only the first ${MAX_RESULT_ROWS} are shown. Narrow the query — add a WHERE filter, an ORDER BY, or a smaller LIMIT.`;
    }
    return JSON.stringify(rows, null, 2);
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === PG_QUERY_CANCELED
    )
      return `Query error: cancelled after ${DB_QUERY_TIMEOUT_SECONDS}s. Narrow the query — add a LIMIT and filter on indexed columns.`;
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
  'close_ticket_as_spam',
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
      case 'close_ticket_as_spam': {
        const res = await freshdeskCaller.closeAsSpam(args.ticket_id as number);
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
      case 'investigate_moderation':
      case 'investigate_crypto_payments': {
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
          investigate_crypto_payments: investigateCryptoPayments,
        } as const;
        result = await investigationFns[name](userId);
        break;
      }
      case 'check_site_status': {
        result = await checkSiteStatus();
        break;
      }
      case 'query_database': {
        result = await executeQueryDatabase(args.sql as string);
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
  investigateCryptoPaymentsTool,
  checkSiteStatusTool,
];

export function getToolsForPhase(phase: FreshdeskWebhookPhase): ToolDefinitionJson[] {
  switch (phase) {
    case 'kb-article':
      return [...COMMON_TOOLS, ...KB_TOOLS, queryDatabaseTool];
    case 'triage':
      return [...COMMON_TOOLS, closeTicketAsSpamTool];
    case 'investigation':
      return [...COMMON_TOOLS, ...INVESTIGATION_TOOLS, queryDatabaseTool];
  }
}
