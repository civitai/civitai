import { Autocomplete, Select, Stack, Text } from '@mantine/core';
import { useMemo } from 'react';
import {
  agentReportRunLabel,
  type AgentReportRunSummary,
} from '~/components/Apps/agentReviewReport';
import {
  AGENT_REVIEW_MODEL_MAX_PROMPT_PER_M,
  formatModelPricePerM,
  isAgentReviewModelId,
  type AgentReviewModelOption,
} from '~/shared/constants/agent-review-model.constants';
import { trpc } from '~/utils/trpc';

/**
 * The two pickers on the agent review panel: which run to look at, and which model a whole-report
 * re-run uses. Every value shown (model ids and names, from OpenRouter or from a report row) is
 * rendered as inert React text.
 */

/** Whether the model field's current text can be dispatched: blank (the default) or a valid id. */
export function isDispatchableModelInput(value: string): boolean {
  const v = value.trim();
  return v === '' || isAgentReviewModelId(v);
}

/**
 * The model for a whole-report re-run: an autocomplete over OpenRouter's tool-capable models
 * (name plus price per million tokens), that also accepts a typed id. Blank means the review
 * agent's default model. Without the list a chosen model cannot be priced, so the field then only
 * says to leave it blank.
 */
export function AgentReviewModelInput({
  publishRequestId,
  value,
  onChange,
  disabled,
}: {
  publishRequestId: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const modelsQuery = trpc.blocks.getAgentReviewModels.useQuery(
    { publishRequestId },
    { retry: false, staleTime: 10 * 60 * 1000, refetchOnWindowFocus: false }
  );
  const models: readonly AgentReviewModelOption[] = useMemo(
    () => modelsQuery.data?.models ?? [],
    [modelsQuery.data]
  );
  const byId = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);
  // OpenRouter could not be reached: a chosen model cannot be priced, so the server refuses every
  // id until it can. (A query that ERRORED — e.g. refused — gets a generic line instead.)
  const listUnavailable = modelsQuery.data?.available === false;
  const invalid = !isDispatchableModelInput(value);
  const chosen = byId.get(value.trim());

  return (
    <Autocomplete
      size="xs"
      label="Model"
      placeholder="Default model"
      value={value}
      onChange={onChange}
      disabled={disabled}
      data={models.map((m) => m.id)}
      limit={50}
      maxDropdownHeight={280}
      clearable
      error={invalid ? 'Expected an OpenRouter model id, like vendor/model' : undefined}
      description={
        chosen
          ? `${chosen.name} · ${formatModelPricePerM(chosen)}`
          : listUnavailable
          ? "OpenRouter's model list is unavailable right now, so other models can't be used. Leave this blank to run on the default model."
          : modelsQuery.isError
          ? 'Could not load the model list. Leave this blank to run on the default model.'
          : `Blank uses the default model. Models up to $${AGENT_REVIEW_MODEL_MAX_PROMPT_PER_M} per million input tokens; the per-run cost cap applies to any model.`
      }
      renderOption={({ option }) => {
        const m = byId.get(option.value);
        return (
          <Stack gap={0}>
            <Text size="xs">{m?.name ?? option.value}</Text>
            <Text size="xs" c="dimmed">
              {option.value}
              {m ? ` · ${formatModelPricePerM(m)}` : ''}
            </Text>
          </Stack>
        );
      }}
      data-testid="apps-agent-model-input"
    />
  );
}

/**
 * Every run of this review, newest first, defaulting to the latest. Picking one shows that
 * report, and the follow-up chat answers about it.
 */
export function AgentReviewReportPicker({
  runs,
  value,
  onChange,
}: {
  runs: readonly AgentReportRunSummary[];
  /** The run on screen; `null` = the latest. */
  value: string | null;
  onChange: (reportId: string | null) => void;
}) {
  const latestId = runs[0]?.id ?? null;
  return (
    <Select
      size="xs"
      label="Report"
      allowDeselect={false}
      value={value ?? latestId}
      onChange={(id) => onChange(!id || id === latestId ? null : id)}
      data={runs.map((r, i) => ({
        value: r.id,
        label: `${agentReportRunLabel(r)}${i === 0 ? ' (latest)' : ''}`,
      }))}
      data-testid="apps-agent-report-picker"
    />
  );
}
