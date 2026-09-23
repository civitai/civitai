/**
 * Experimental presentation — the flask and its warning.
 *
 * One marker component serves every level a gate rule can target (ecosystem,
 * workflow, model version). It resolves its own state, so a picker adds a flask
 * with a `target` and no new props to thread.
 *
 * Two surfaces, each complete on its own rather than one controlling the other:
 *   - the flask, at the point of choice, carrying the full message on hover or
 *     tap. It answers "why is this marked?" where the marker is.
 *   - one alert per selected item, beside the model selector rather than in the
 *     footer, so the explanation sits where the choice was made. None is
 *     dismissible.
 *
 * Standalone messaging (pricing, maintenance) is a separate system that renders
 * in the footer — see `shared/generation/messages.ts`.
 */

import { Alert, Popover, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle, IconFlask } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';

import { useGenerationConfig } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import { workflowConfigByKey } from '~/shared/data-graph/generation/config/workflows';
import { experimentalTargets, gateMessage } from '~/shared/data-graph/generation/gates';
import { useDisabledGates } from '~/components/generation_v2/gate-block';
import {
  resolveExperimental,
  resolveExperimentalMatches,
  type ExperimentalMatch,
  type ExperimentalTarget,
} from '~/shared/data-graph/generation/experimental';
import { setExperimentalRules, useExperimentalRulesStore } from '~/store/experimental-rules.store';

// =============================================================================
// Copy
// =============================================================================

const TAIL = 'Some features may not work as expected. Please report any issues you encounter.';

function subjectOf(target: ExperimentalTarget): string {
  switch (target.kind) {
    case 'ecosystem':
      return `${ecosystemByKey.get(target.key)?.displayName ?? target.key} support`;
    case 'workflow': {
      const label = workflowConfigByKey.get(target.key)?.label;
      return label ? `The ${label} workflow` : 'This workflow';
    }
    case 'modelVersion':
      return 'The selected model version';
  }
}

/** What the flask and the alert both say. */
function messageOf(match: ExperimentalMatch): string {
  return (
    match.message ?? `${subjectOf(match.target)} is currently in an experimental phase. ${TAIL}`
  );
}

// =============================================================================
// Config mirror
// =============================================================================

/**
 * Mirrors the generator config's gate rules into the store the markers read.
 * Mounted once by each generator root — without it every marker and alert
 * silently renders nothing.
 */
export function ExperimentalRulesSync() {
  const { gateRules } = useGenerationConfig();

  useEffect(() => {
    setExperimentalRules(gateRules);
  }, [gateRules]);

  return null;
}

// =============================================================================
// Hooks
// =============================================================================

/** The experimental state of one target, or `undefined` when it isn't. */
export function useExperimental(target?: ExperimentalTarget): ExperimentalMatch | undefined {
  const rules = useExperimentalRulesStore((state) => state.rules);

  return useMemo(() => {
    if (!target) return undefined;
    return resolveExperimental(experimentalTargets(rules), target);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- target is a literal; compare by value
  }, [rules, target?.kind, target?.key]);
}

const candidatesFingerprint = (candidates: (ExperimentalTarget | undefined)[]) =>
  candidates.map((c) => (c ? `${c.kind}:${c.key}` : '')).join(',');

/** Every experimental match among the candidates, in the order given. */
export function useExperimentalMatches(
  candidates: (ExperimentalTarget | undefined)[]
): ExperimentalMatch[] {
  const rules = useExperimentalRulesStore((state) => state.rules);
  const fingerprint = candidatesFingerprint(candidates);

  return useMemo(
    () => resolveExperimentalMatches(experimentalTargets(rules), candidates),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- candidates is rebuilt each render; compare by value
    [rules, fingerprint]
  );
}

// =============================================================================
// Form selection → targets
// =============================================================================

export type ExperimentalSelection = {
  ecosystem?: string;
  workflow?: string;
  model?: unknown;
  resources?: unknown;
  vae?: unknown;
};

/**
 * Every target a form selection could match. Resources are read by id alone: the
 * graph's resource value is minimal (`{ id, model: { type } }`) and gains `name`
 * only through server enrichment, so any richer shape check silently misses the
 * checkpoint the graph selected itself.
 */
export function experimentalSelectionTargets({
  ecosystem,
  workflow,
  model,
  resources,
  vae,
}: ExperimentalSelection): (ExperimentalTarget | undefined)[] {
  const hasId = (value: unknown): value is { id: number } =>
    value !== null &&
    typeof value === 'object' &&
    'id' in value &&
    typeof (value as { id: unknown }).id === 'number';

  const resourceTargets = [model, ...(Array.isArray(resources) ? resources : []), vae]
    .filter(hasId)
    .map((r): ExperimentalTarget => ({ kind: 'modelVersion', key: r.id }));

  return [
    ecosystem ? { kind: 'ecosystem', key: ecosystem } : undefined,
    workflow ? { kind: 'workflow', key: workflow } : undefined,
    ...resourceTargets,
  ];
}

// =============================================================================
// Flask
// =============================================================================

interface ExperimentalFlaskProps {
  /** Renders nothing when this target isn't experimental. */
  target?: ExperimentalTarget;
  size?: number;
  className?: string;
}

/**
 * The marker, carrying its own message. Opens on hover for a pointer and on tap
 * for touch, where hover never fires — the message can't live in a tooltip for
 * that reason, nor in the body alert alone, which is too far from the picker to
 * explain it.
 *
 * The target is a `span`, not a button: pickers put the flask inside a row that
 * is itself a button, and clicks are stopped so opening the message never doubles
 * as selecting the row.
 */
export function ExperimentalFlask({ target, size = 18, className }: ExperimentalFlaskProps) {
  const match = useExperimental(target);
  const [opened, setOpened] = useState(false);

  if (!match) return null;

  const toggle = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setOpened((o) => !o);
  };

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="top"
      width={260}
      withArrow
      withinPortal
      shadow="md"
    >
      <Popover.Target>
        <span
          role="button"
          tabIndex={0}
          aria-expanded={opened}
          aria-label="Experimental — details"
          className={clsx('inline-flex shrink-0 cursor-help', className)}
          onMouseEnter={() => setOpened(true)}
          onMouseLeave={() => setOpened(false)}
          onClick={toggle}
          onKeyDown={(e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') toggle(e);
          }}
        >
          <ThemeIcon size={size} color="violet" variant="light">
            <IconFlask size={size * 0.7} />
          </ThemeIcon>
        </span>
      </Popover.Target>
      {/* Keeps the message open while the pointer travels into it. */}
      <Popover.Dropdown
        p="xs"
        onMouseEnter={() => setOpened(true)}
        onMouseLeave={() => setOpened(false)}
      >
        <Text size="xs" fw={600} c="violet.4" mb={2}>
          Experimental
        </Text>
        <Text size="xs">{messageOf(match)}</Text>
      </Popover.Dropdown>
    </Popover>
  );
}

// =============================================================================
// Warning
// =============================================================================

/** Every block and experimental warning the current selection has earned. */
export function GateRuleAlerts({ selection }: { selection: ExperimentalSelection }) {
  const candidates = experimentalSelectionTargets(selection);
  const blocks = useDisabledGates(selection);
  const matches = useExperimentalMatches(candidates);

  if (!blocks.length && !matches.length) return null;

  return (
    <div className="flex flex-col gap-2">
      {blocks.map((gate) => (
        <Alert
          key={`${gate.subject}:${gate.state}`}
          color="orange"
          radius="md"
          py={8}
          icon={<IconAlertTriangle size={20} />}
          // Title-less: Mantine's icon slot is a fixed 20px box in a wrapper with
          // no `align-items`, so the icon hangs above single-line copy without this.
          classNames={{ wrapper: 'items-center' }}
        >
          <Text size="xs">{gateMessage(gate)}</Text>
        </Alert>
      ))}
      {matches.map((match) => (
        <Alert
          key={match.key}
          color="violet"
          radius="md"
          py={8}
          icon={<IconFlask size={18} />}
          title="Experimental Build"
        >
          <Text size="xs">{messageOf(match)}</Text>
        </Alert>
      ))}
    </div>
  );
}
