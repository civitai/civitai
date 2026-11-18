import { env } from '$env/dynamic/private';
import {
  AGENT_REPORT_PARAM,
  isAgentReportFilter,
  type AgentReportFilter,
} from '$lib/agent-reports';
import { parseIdList } from './query';

/** The ids in `AGENT_REPORTER_USER_IDS`; anything not a positive int4 is dropped. */
export function parseAgentReporterIds(raw: string | undefined): number[] {
  return [...new Set(parseIdList(raw ?? ''))];
}

let ids: number[] | undefined;
/** Parsed on first use rather than at import, so the server's env is loaded by then. */
export function agentReporterIds(): number[] {
  return (ids ??= parseAgentReporterIds(env.AGENT_REPORTER_USER_IDS));
}

/**
 * The `?agents=` filter a queue applies, or `null` when no agent accounts are configured — the queue then
 * shows no control and ignores the param, rather than offering a filter that can only empty the list.
 */
export function agentReportFilterOf(url: URL): AgentReportFilter | null {
  if (!agentReporterIds().length) return null;
  const raw = url.searchParams.get(AGENT_REPORT_PARAM);
  return isAgentReportFilter(raw) ? raw : 'all';
}

/** What the queries take: the ids to match and which way, or nothing to filter. */
export type AgentReportWhere = { mode: 'only' | 'hide'; ids: number[] } | undefined;

export function agentReportWhere(filter: AgentReportFilter | null): AgentReportWhere {
  return filter === 'only' || filter === 'hide'
    ? { mode: filter, ids: agentReporterIds() }
    : undefined;
}

export const isAgentReporter = (userId: number | null | undefined) =>
  userId != null && agentReporterIds().includes(userId);
