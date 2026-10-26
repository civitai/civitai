import * as z from 'zod';
import { logToAxiom } from '~/server/logging/client';
import { blockTaskBodySchema, PASS_THROUGH_MAX_BUZZ } from '~/server/schema/blocks/workflow.schema';
import {
  refundBlockBuzzSpend,
  reserveBlockBuzzSpend,
} from '~/server/services/blocks/block-buzz-cap';
import {
  assertStepTypeAllowed,
  PlatformInternalStepTypeError,
} from '~/server/services/blocks/steps/orchestrator-denylist';
import { splitPassThroughStep } from '~/server/services/blocks/steps/output';
import type { TaskRouterConfig } from '~/server/services/blocks/task-router.service';
import {
  findTasks,
  matchTask,
  reportTaskStarted,
  taskRouterJwks,
  taskRouterUserRef,
  TaskTicketError,
  verifyTaskTicket,
} from '~/server/services/blocks/task-router.service';
import { resolveBlockWorkflowGraph } from '~/server/services/blocks/workflow-graph';
import { assertWorkflowOwner } from '~/server/services/orchestrator/assert-workflow-owner';
import { getWorkflow, submitWorkflow } from '~/server/services/orchestrator/workflows';
import { orderBlockCurrencyTypes } from '~/server/utils/buzz-helpers';
import {
  BLOCK_BUZZ_CAP_PER_DAY,
  BLOCK_WORKFLOW_MAX_BUZZ_PER_CALL,
} from '~/shared/constants/block-scope.constants';
import { BuzzTypes } from '~/shared/constants/buzz.constants';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_WORKFLOW_TAG = 'task-router-mcp';
const RUN_WAIT_SECONDS = 25;
const FIND_LIMIT_MAX = 20;

/** Who is calling: the bearer's user, its own token (the orchestrator spends and limits on it). */
export type McpCaller = {
  userId: number;
  token: string;
  subject: { type: 'oauth' | 'apiKey'; id: string | number };
};

/** `client:<oauth client id>` or `user:<user id>`. */
export function isMcpCallerAllowed(config: TaskRouterConfig, caller: McpCaller): boolean {
  const entries = new Set(config.appAllowlist);
  return (
    entries.has(`user:${caller.userId}`) ||
    (caller.subject.type === 'oauth' && entries.has(`client:${caller.subject.id}`))
  );
}

const TOOLS = [
  {
    name: 'find_tasks',
    description:
      'Search the Civitai task menu. Returns matching tasks with their input schema, quality ' +
      'tiers and a rough price in Buzz.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What you want done, in plain words.' },
        limit: { type: 'integer', minimum: 1, maximum: FIND_LIMIT_MAX },
      },
      required: ['description'],
    },
  },
  {
    name: 'run_task',
    description:
      'Run a task from the menu (`task`), a chain of up to 8 (`steps`, a later input may hold ' +
      '{ "$ref": "<earlier step name>", "output": "image" }), or ask for something by ' +
      '`description` alone. Spends your own Buzz, at most `budget.amount`. Off-menu asks are ' +
      'recorded and answered with the closest tasks. Pass only `workflowId` to check a run.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        input: { type: 'object' },
        steps: { type: 'array', items: { type: 'object' } },
        description: { type: 'string' },
        quality: { enum: ['draft', 'standard', 'best'] },
        routing: { enum: ['sticky', 'each-request'] },
        budget: {
          type: 'object',
          properties: { amount: { type: 'integer', minimum: 1 }, currency: { const: 'buzz' } },
          required: ['amount'],
        },
        workflowId: { type: 'string' },
      },
    },
  },
] as const;

const findArgsSchema = z.object({
  description: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(FIND_LIMIT_MAX).default(5),
});
const statusArgsSchema = z.object({ workflowId: z.string().min(1).max(128) }).strict();
const runArgsSchema = z
  .object({
    budget: z.object({ amount: z.number().int().min(1), currency: z.literal('buzz').optional() }),
  })
  .passthrough();

type ToolResult = { result: Record<string, unknown>; isError?: boolean };
const toolError = (message: string, extra: Record<string, unknown> = {}): ToolResult => ({
  result: { error: message, ...extra },
  isError: true,
});

async function findTasksTool(config: TaskRouterConfig, args: unknown): Promise<ToolResult> {
  const parsed = findArgsSchema.safeParse(args);
  if (!parsed.success) return toolError('find_tasks needs a `description`');
  const items = await findTasks(config, parsed.data.description, parsed.data.limit);
  if (!items) return toolError('the task menu is unavailable; try again shortly');
  return { result: { items } };
}

type WorkflowLike = Awaited<ReturnType<typeof getWorkflow>>;

/** The last step's media is the run's result; earlier steps are intermediate. */
function runSummary(workflow: WorkflowLike) {
  const steps = (workflow.steps ?? []) as { $type?: string; output?: unknown }[];
  const last = steps[steps.length - 1];
  const media = last?.$type ? splitPassThroughStep(last.$type, last.output).media : [];
  return {
    workflowId: workflow.id,
    status: workflow.status,
    outputs: media.map((m) => m.url),
    ...(typeof workflow.cost?.total === 'number'
      ? { cost: { amount: workflow.cost.total, currency: 'buzz' } }
      : {}),
  };
}

async function runStatusTool(caller: McpCaller, workflowId: string): Promise<ToolResult> {
  // The orchestrator answers a consumer read only for the token's own workflows.
  const workflow = await getWorkflow({ token: caller.token, path: { workflowId } }).catch(
    () => null
  );
  if (!workflow) return toolError('no such run for this account');
  return { result: runSummary(workflow) };
}

async function runTaskTool(
  config: TaskRouterConfig,
  caller: McpCaller,
  args: unknown
): Promise<ToolResult> {
  const status = statusArgsSchema.safeParse(args);
  if (status.success) return runStatusTool(caller, status.data.workflowId);

  const run = runArgsSchema.safeParse(args);
  if (!run.success) return toolError('run_task needs a `budget: { amount }` in Buzz');
  const { budget: askedBudget, ...rest } = run.data;
  const body = blockTaskBodySchema.safeParse({
    kind: 'task',
    ...rest,
    maxBuzz: Math.min(askedBudget.amount, BLOCK_WORKFLOW_MAX_BUZZ_PER_CALL),
  });
  if (!body.success) {
    return toolError('run_task arguments are invalid', {
      issues: body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const { kind: _kind, maxBuzz, ...request } = body.data;
  const stepCount = request.steps?.length ?? 1;
  const budget = {
    amount: Math.min(
      maxBuzz,
      stepCount === 1 ? PASS_THROUGH_MAX_BUZZ : BLOCK_WORKFLOW_MAX_BUZZ_PER_CALL
    ),
    currency: 'buzz',
  };
  const user = taskRouterUserRef(config.partyKey, caller.userId);

  const matched = await matchTask(config, {
    ...request,
    budget,
    requester: { app: `${caller.subject.type}:${caller.subject.id}`, user },
  });
  if (!matched.ok) return toolError(matched.message, { code: matched.code });
  if ('notYet' in matched) {
    return {
      result: {
        status: 'not_yet',
        message: 'Not on the menu yet. The request was recorded; these are the closest tasks.',
        demandId: matched.notYet.demandId,
        closest: matched.notYet.closest,
      },
    };
  }
  const { match } = matched;

  let ticket: Awaited<ReturnType<typeof verifyTaskTicket>>;
  try {
    ticket = await verifyTaskTicket(match.ticket, {
      jwks: taskRouterJwks(config),
      audience: config.partyId,
      budget,
      user,
      callbackOrigin: config.callbackOrigin,
    });
  } catch (e) {
    if (!(e instanceof TaskTicketError)) throw e;
    logToAxiom(
      { name: 'mcp-task-ticket-refused', type: 'error', message: e.message, taskId: match.taskId },
      'civitai-prod'
    ).catch(() => undefined);
    return toolError(e.message, { code: 'task-ticket-invalid' });
  }
  if (ticket.taskId !== match.taskId) {
    return toolError('ticket task id does not match the match', { code: 'task-ticket-invalid' });
  }

  const graph = resolveBlockWorkflowGraph({ steps: ticket.steps });
  if (!graph.ok) return toolError(graph.error, { code: 'task-ticket-invalid' });
  try {
    for (const step of graph.steps) {
      for (const stepType of step.stepTypes)
        assertStepTypeAllowed(stepType, 'task router mcp step');
    }
  } catch (e) {
    if (e instanceof PlatformInternalStepTypeError) {
      return toolError(e.message, { code: 'task-ticket-invalid' });
    }
    throw e;
  }

  // Agents loop, so MCP spend draws on the same per-user daily ceiling as App Blocks.
  const reserved = Math.max(1, ticket.quote.amount);
  const { total, key } = await reserveBlockBuzzSpend(caller.userId, reserved);
  if (total > BLOCK_BUZZ_CAP_PER_DAY) {
    await refundBlockBuzzSpend(key, reserved);
    return toolError(
      `daily Buzz cap reached: ${total - reserved} already spent today through apps and agents, ` +
        `this task may cost ${reserved}, the daily cap is ${BLOCK_BUZZ_CAP_PER_DAY}`,
      { code: 'daily_cap' }
    );
  }

  let submitted: Awaited<ReturnType<typeof submitWorkflow>>;
  try {
    submitted = await submitWorkflow({
      token: caller.token,
      body: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        steps: ticket.steps as any,
        tags: [MCP_WORKFLOW_TAG, ...ticket.tags],
        metadata: ticket.metadata,
        currencies: BuzzTypes.toOrchestratorType(orderBlockCurrencyTypes(true).ordered),
        allowMatureContent: false,
        externalId: `trmcp-${ticket.taskId}`,
        ...(ticket.callbacks.length
          ? {
              // The verifier pins each url to the router origin but leaves `type` as free strings.
              callbacks: ticket.callbacks as NonNullable<
                Parameters<typeof submitWorkflow>[0]['body']
              >['callbacks'],
            }
          : {}),
      },
    });
  } catch (e) {
    await refundBlockBuzzSpend(key, reserved);
    throw e;
  }
  await assertWorkflowOwner(submitted, caller.userId, caller.token);
  if (submitted.id) void reportTaskStarted(config, ticket.taskId, submitted.id);

  const finished = submitted.id
    ? await getWorkflow({
        token: caller.token,
        path: { workflowId: submitted.id },
        query: { wait: RUN_WAIT_SECONDS },
      }).catch(() => submitted)
    : submitted;
  return {
    result: {
      ...runSummary(finished),
      taskId: ticket.taskId,
      resolvedAs: match.resolvedAs,
      moved: match.resolvedAs.some((step) => step.assignment.event === 'moved'),
      ...(match.unknownFields ? { unknownFields: match.unknownFields } : {}),
    },
  };
}

const rpcSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

type RpcResponse = { jsonrpc: '2.0'; id: string | number | null } & (
  | { result: unknown }
  | { error: { code: number; message: string } }
);

/**
 * One JSON-RPC message of the MCP streamable-HTTP transport (no sessions, no streaming).
 * `null` for a notification, which gets no reply.
 */
export async function handleMcpMessage(
  config: TaskRouterConfig,
  caller: McpCaller,
  message: unknown
): Promise<RpcResponse | null> {
  const parsed = rpcSchema.safeParse(message);
  if (!parsed.success) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
  }
  const { id, method, params } = parsed.data;
  if (id === undefined) return null;
  const reply = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'civitai-tasks', version: '0.1.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const outcome =
        name === 'find_tasks'
          ? await findTasksTool(config, args)
          : name === 'run_task'
          ? await runTaskTool(config, caller, args)
          : null;
      if (!outcome) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } };
      }
      return reply({
        content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
        structuredContent: outcome.result,
        ...(outcome.isError ? { isError: true } : {}),
      });
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } };
  }
}
