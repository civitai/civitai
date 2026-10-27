import { Badge, CloseButton, Indicator, Text, UnstyledButton } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import {
  IconBookmark,
  IconChevronDown,
  IconChevronUp,
  IconDeviceFloppy,
  IconLayoutGrid,
  IconLayoutList,
  IconList,
  IconMenu2,
  IconTrophy,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useField } from 'form-graph/react';
import type { PointerEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useGetActiveChallenges } from '~/components/Challenges/challenge.utils';
import { openChallengeInvitation } from '~/components/Challenges/ChallengeIndicator';
import type { GenerationStore } from '~/components/form-graph/generation/store';
import { PopoverOrSheet } from '~/components/generation_v2/PopoverOrSheet';
import {
  openManagePresets,
  openPresetPicker,
  openSavePreset,
} from '~/components/generation_v2/preset/PresetHeaderButton';
import { GeneratedImageActions } from '~/components/ImageGeneration/GeneratedImageActions';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { GenerationResults } from '~/components/ImageGeneration/GenerationResults';
import { useGetTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useHistoryLayer } from '~/hooks/useHistoryLayer';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { POLLABLE_STATUSES } from '~/shared/constants/orchestrator.constants';
import { workflowConfigByKey } from '~/shared/generation/config/workflows';
import { useActiveGenerationForm } from '~/store/active-generation-form.store';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import type { GenerationResultsView } from '~/store/generation-panel.store';
import { useMobileGeneratorStore } from '~/store/mobile-generator.store';
import { useGenerationPresetStore } from '~/store/generation-preset.store';
import classes from './MobileGenerator.module.scss';

/** How far the sheet's head must be dragged before letting go opens or closes it. */
const OPEN_DRAG = 24;
const CLOSE_DRAG = 60;
const HINT_KEY = 'mobile-generator-sheet-hint';

type Props = { form: ReactNode; onClose: () => void; closeLabel: string };

/**
 * The generator on a phone: the queue is the screen, and the form is a bottom sheet over it that
 * rests as a one-line summary bar. The panel's `view` drives the sheet — 'generate' is the sheet
 * open, 'queue' and 'feed' are the two densities of the results under it — so every way into the
 * generator that asks for the form opens the sheet.
 */
export function MobileGenerator({ form, onClose, closeLabel }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const view = useGenerationPanelStore((state) => state.view);
  const expanded = view === 'generate';

  // The results stay on screen under the open sheet, so keep the last density chosen.
  const resultsViewRef = useRef<GenerationResultsView>(view === 'generate' ? 'queue' : view);
  if (view !== 'generate') resultsViewRef.current = view;
  const resultsView = resultsViewRef.current;

  const open = () => generationGraphPanel.setView('generate');
  const close = () => generationGraphPanel.setView(resultsViewRef.current);
  useHistoryLayer(expanded, close);

  useEffect(() => {
    useMobileGeneratorStore.setState({ showing: true });
    return () => useMobileGeneratorStore.setState({ showing: false });
  }, []);

  // Generate closes the sheet, and the new batch is at the top of the results.
  const submittedAt = useMobileGeneratorStore((state) => state.submittedAt);
  useEffect(() => {
    if (!submittedAt) return;
    generationGraphPanel.setView(resultsViewRef.current);
    resultsRef.current?.querySelector('.scroll-area')?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [submittedAt]);

  useVisualViewport(rootRef);

  return (
    <div ref={rootRef} className={classes.root}>
      <header className={classes.header}>
        <GeneratorMenu />
        <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
          <Text fw={700} size="lg">
            Generator
          </Text>
          <QueueCount />
        </div>
        <CloseButton aria-label={closeLabel} onClick={onClose} size="lg" variant="transparent" />
      </header>
      <div ref={resultsRef} className={classes.results} {...inert(expanded)}>
        <div className="flex items-center gap-2 px-3 py-2">
          <DensityToggle value={resultsView} />
          <div className="min-w-0 flex-1">
            <GeneratedImageActions />
          </div>
        </div>
        <GenerationResults view={resultsView} />
      </div>
      <div
        className={classes.scrim}
        data-visible={expanded || undefined}
        onClick={close}
        aria-hidden
      />
      <FormSheet expanded={expanded} onOpen={open} onClose={close}>
        {form}
      </FormSheet>
    </div>
  );
}

function FormSheet({
  expanded,
  onOpen,
  onClose,
  children,
}: {
  expanded: boolean;
  onOpen: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; dy: number; pointerId: number }>();
  const [dragging, setDragging] = useState(false);

  // First run: once the sheet has been closed, the handle nudges and a hint says how to open it,
  // until the first time it is opened from the bar.
  const [hint, setHint] = useLocalStorage<'pending' | 'shown' | 'done'>({
    key: HINT_KEY,
    defaultValue: 'pending',
    getInitialValueInEffect: false,
  });
  useEffect(() => {
    if (!expanded && hint === 'pending') setHint('shown');
  }, [expanded, hint, setHint]);
  const openFromBar = () => {
    if (hint !== 'done') setHint('done');
    onOpen();
  };

  const setDragOffset = (dy: number) =>
    sheetRef.current?.style.setProperty('--sheet-drag', `${dy}px`);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    // The closed bar is itself a button and drags too; the title row's buttons don't.
    if ((e.target as HTMLElement).closest('button:not([data-sheet-bar])')) return;
    drag.current = { startY: e.clientY, dy: 0, pointerId: e.pointerId };
    // Keeps the moves coming when the finger leaves the head. Throws for a pointer that is no
    // longer down, which the drag can do without.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== e.pointerId) return;
    // An open sheet only drags down and a closed one only up.
    const dy = expanded
      ? Math.max(0, e.clientY - current.startY)
      : Math.min(0, e.clientY - current.startY);
    current.dy = dy;
    if (!dragging && Math.abs(dy) > 4) setDragging(true);
    setDragOffset(dy);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== e.pointerId) return;
    drag.current = undefined;
    setDragging(false);
    setDragOffset(0);
    const moved = Math.abs(current.dy) > 4;
    if (expanded && current.dy > CLOSE_DRAG) onClose();
    else if (!expanded && (!moved || current.dy < -OPEN_DRAG)) openFromBar();
  };
  const onPointerCancel = () => {
    drag.current = undefined;
    setDragging(false);
    setDragOffset(0);
  };

  return (
    <section
      ref={sheetRef}
      className={classes.sheet}
      data-expanded={expanded || undefined}
      data-dragging={dragging || undefined}
      aria-label="Generation form"
    >
      {!expanded && hint === 'shown' && (
        <p className={classes.hint} role="status">
          Pull up or tap to open the form
        </p>
      )}
      <div
        className={classes.head}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {expanded ? (
          // The handle sits in the title row, centred between the title and the chevron.
          <div className="grid min-h-11 grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 pt-1">
            <SheetTitle />
            <div className={classes.grab} aria-hidden />
            <LegacyActionIcon
              aria-label="Close the form"
              variant="subtle"
              color="gray"
              size="lg"
              className="justify-self-end"
              onClick={onClose}
            >
              <IconChevronDown size={20} />
            </LegacyActionIcon>
          </div>
        ) : (
          <>
            <div
              className={clsx(classes.grab, classes.grabAbove, hint === 'shown' && classes.nudge)}
              aria-hidden
            />
            <UnstyledButton
              data-sheet-bar
              className="flex min-h-[52px] w-full items-center gap-2 px-3"
              aria-label="Open the form"
              onClick={openFromBar}
            >
              <FormSummary />
              <IconChevronUp size={20} className="shrink-0" />
            </UnstyledButton>
          </>
        )}
      </div>
      <div className={classes.body} {...inert(!expanded)}>
        {children}
      </div>
    </section>
  );
}

function useFormStore() {
  return useActiveGenerationForm((state) => state.store);
}

function SheetTitle() {
  const store = useFormStore();
  return (
    <Text fw={700} className="min-w-0 flex-1 truncate">
      {store ? <WorkflowLabel store={store} /> : 'Generate'}
    </Text>
  );
}

function WorkflowLabel({ store }: { store: GenerationStore }) {
  const workflow = useField<string>(store, 'workflow')?.value;
  return <>{(workflow && workflowConfigByKey.get(workflow)?.label) ?? 'Generate'}</>;
}

/** The closed sheet's one line: workflow, then prompt · model · size · quantity. */
function FormSummary() {
  const store = useFormStore();
  return (
    <span className="flex min-w-0 flex-1 flex-col text-left">
      <Text
        component="span"
        size="xs"
        fw={700}
        c="blue.4"
        tt="uppercase"
        className="truncate tracking-wide"
      >
        {store ? <WorkflowLabel store={store} /> : 'Generate'}
      </Text>
      <Text component="span" size="sm" c="dimmed" className="truncate">
        {store ? <SummaryParts store={store} /> : 'Tap to open the form'}
      </Text>
    </span>
  );
}

function SummaryParts({ store }: { store: GenerationStore }) {
  const prompt = useField<string>(store, 'prompt')?.value;
  const model = useField<{ model?: { name?: string } }>(store, 'model')?.value;
  const aspectRatio = useField<{ value?: string; width?: number; height?: number }>(
    store,
    'aspectRatio'
  )?.value;
  const quantity = useField<number>(store, 'quantity')?.value;

  const size =
    aspectRatio?.value === 'custom' && aspectRatio.width && aspectRatio.height
      ? `${aspectRatio.width}×${aspectRatio.height}`
      : aspectRatio?.value;
  const parts = [
    prompt?.trim() || 'No prompt yet',
    model?.model?.name,
    size,
    quantity ? `×${quantity}` : undefined,
  ].filter(Boolean);
  return <>{parts.join(' · ')}</>;
}

function DensityToggle({ value }: { value: GenerationResultsView }) {
  const options = [
    { value: 'queue', label: 'Batches', Icon: IconLayoutList },
    { value: 'feed', label: 'Grid', Icon: IconLayoutGrid },
  ] as const;
  return (
    <div
      role="group"
      aria-label="Density"
      data-tap-target="group"
      className="flex shrink-0 rounded-md border border-gray-3 p-0.5 dark:border-dark-4"
    >
      {options.map(({ value: option, label, Icon }) => (
        <UnstyledButton
          key={option}
          aria-label={label}
          aria-pressed={value === option}
          onClick={() => generationGraphPanel.setView(option)}
          className={clsx(
            'flex min-w-11 items-center justify-center rounded',
            value === option ? 'bg-gray-2 dark:bg-dark-5' : 'text-gray-6 dark:text-dark-2'
          )}
        >
          <Icon size={18} />
        </UnstyledButton>
      ))}
    </div>
  );
}

/** Jobs in flight against the tier's queue limit. */
function QueueCount() {
  const { limits } = useGenerationStatus();
  const { data: requests } = useGetTextToImageRequests(undefined, {
    includeTags: false,
    ignoreFilters: true,
  });
  const queued = requests.filter((request) => POLLABLE_STATUSES.includes(request.status)).length;
  if (!limits.queue) return null;
  const full = queued >= limits.queue;
  return (
    <Badge variant="light" color={full ? 'yellow' : 'gray'} aria-label="Jobs in the queue">
      {queued}/{limits.queue}
    </Badge>
  );
}

/** Daily challenges and presets. The tour and moderator tools are not shown on phones. */
function GeneratorMenu() {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const [opened, setOpened] = useState(false);
  const { challenges } = useGetActiveChallenges();
  const canSavePreset = useGenerationPresetStore((s) => !!s.bridge.getFilteredSnapshot);

  const showChallenges = features.challengePlatform && challenges.length > 0;
  const showPresets = features.generationPresets && !!currentUser;
  if (!showChallenges && !showPresets) return null;

  const unseenChallenges = challenges.some((challenge) => !challenge.dismissed);
  const choose = (action: () => void) => () => {
    setOpened(false);
    action();
  };

  return (
    <PopoverOrSheet
      opened={opened}
      onClose={() => setOpened(false)}
      title="Generator"
      target={
        <Indicator color="red" size={10} disabled={!showChallenges || !unseenChallenges}>
          <LegacyActionIcon
            aria-label="Challenges and presets"
            variant="subtle"
            color="gray"
            size="lg"
            onClick={() => setOpened(true)}
          >
            <IconMenu2 size={22} />
          </LegacyActionIcon>
        </Indicator>
      }
    >
      <div className="flex flex-col">
        {showChallenges && (
          <MenuRow
            icon={<IconTrophy size={20} />}
            label="Daily challenges"
            onClick={choose(() =>
              openChallengeInvitation(challenges.map((challenge) => challenge.challengeId))
            )}
          />
        )}
        {showPresets && (
          <>
            <MenuRow
              icon={<IconBookmark size={20} />}
              label="View presets"
              onClick={choose(openPresetPicker)}
            />
            <MenuRow
              icon={<IconDeviceFloppy size={20} />}
              label="Save current values"
              onClick={choose(openSavePreset)}
              disabled={!canSavePreset}
            />
            <MenuRow
              icon={<IconList size={20} />}
              label="Manage presets"
              onClick={choose(openManagePresets)}
            />
          </>
        )}
      </div>
    </PopoverOrSheet>
  );
}

function MenuRow({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <UnstyledButton
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-12 items-center gap-3 rounded-md px-3 text-base active:bg-gray-1 disabled:opacity-50 dark:active:bg-dark-6"
    >
      {icon}
      {label}
    </UnstyledButton>
  );
}

/** The covered half takes no focus or taps. React 18 has no `inert` prop, so it is set as an attribute. */
const inert = (on: boolean) => (on ? ({ inert: '' } as object) : {});

/**
 * Sizes the generator to the visual viewport, which shrinks when the iOS keyboard opens while the
 * layout viewport does not, so the form's footer stays above the keyboard.
 */
function useVisualViewport(ref: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const viewport = window.visualViewport;
    const el = ref.current;
    if (!viewport || !el) return;
    const update = () => {
      el.style.setProperty('--generator-height', `${viewport.height}px`);
      el.style.setProperty('--generator-top', `${viewport.offsetTop}px`);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, [ref]);
}
