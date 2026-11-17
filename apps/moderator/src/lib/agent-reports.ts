/**
 * Reports filed by agent accounts (`AGENT_REPORTER_USER_IDS`): the report queues' `?agents=` filter.
 * Absent means every report; `only` and `hide` narrow by `Report.userId`. A reporter merged in through
 * `alsoReportedBy` does not count, so a human report an agent also filed is still a human report.
 */
export const agentReportFilters = ['all', 'only', 'hide'] as const;
export type AgentReportFilter = (typeof agentReportFilters)[number];

export const agentReportFilterLabels: Record<AgentReportFilter, string> = {
  all: 'All reporters',
  only: 'Agents only',
  hide: 'Hide agents',
};

export const AGENT_REPORT_PARAM = 'agents';

export const isAgentReportFilter = (v: unknown): v is AgentReportFilter =>
  (agentReportFilters as readonly unknown[]).includes(v);

/** Writes the filter into a query string; `all` is the absent param. */
export function setAgentReportParam(params: URLSearchParams, filter: AgentReportFilter) {
  if (filter === 'all') params.delete(AGENT_REPORT_PARAM);
  else params.set(AGENT_REPORT_PARAM, filter);
}
