import { Badge, CloseButton, Text, UnstyledButton } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import {
  IconChevronDown,
  IconChevronUp,
  IconChevronsUp,
  IconHandFinger,
  IconLayoutGrid,
  IconLayoutList,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useField } from 'form-graph/react';
import type { CSSProperties, PointerEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { ChallengeIndicator } from '~/components/Challenges/ChallengeIndicator';
import type { GenerationStore } from '~/components/form-graph/generation/store';
import { PresetHeaderButton } from '~/components/generation_v2/preset/PresetHeaderButton';
import { GeneratedImageActions } from '~/components/ImageGeneration/GeneratedImageActions';
import { useSelectedCount } from '~/components/ImageGeneration/utils/generationImage.select';
import {
  GenerationProvider,
  useGenerationContext,
} from '~/components/ImageGeneration/GenerationProvider';
import { GenerationResults } from '~/components/ImageGeneration/GenerationResults';
import { QueueSlots } from '~/components/ImageGeneration/QueueSnackbar';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useHideOnScroll } from '~/hooks/useHideOnScroll';
import { useHistoryLayer } from '~/hooks/useHistoryLayer';
import { useVisualViewportBottomInset } from '~/hooks/useVisualViewportBottomInset';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { workflowConfigByKey } from '~/shared/generation/config/workflows';
import { useActiveGenerationForm } from '~/store/active-generation-form.store';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import type { GenerationResultsView } from '~/store/generation-panel.store';
import { saveMobileGeneratorView, useMobileGeneratorStore } from '~/store/mobile-generator.store';
import classes from './MobileGenerator.module.scss';
import {
  MobileGeneratorSlots,
  RenderTitleActions,
} from '~/components/ImageGeneration/mobile-generator-slots';

/** Fields that bring up the on-screen keyboard. */
const TEXT_ENTRY =
  'textarea:not([readonly]), [contenteditable="true"], input:not([readonly], [type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="range"], [type="file"])';
const isTextEntry = (el: EventTarget | null) => el instanceof Element && el.matches(TEXT_ENTRY);

const OPEN_DRAG = 24;
const CLOSE_DRAG = 60;
// Named for the hint the coach replaced; renaming it would show the coach again to everyone.
const COACH_KEY = 'mobile-generator-sheet-hint';
const TITLE_ROW = 'flex min-h-12 items-center gap-2 px-3';

type Props = { form: ReactNode; onClose: () => void; closeLabel: string };

/**
 * The generator on a phone: the results are the screen, and the form is a bottom sheet over them.
 * The panel's `view` drives the sheet ('generate' is open), so every way into the generator that
 * asks for the form opens the sheet.
 */
export function MobileGenerator({ form, onClose, closeLabel }: Props) {
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

  useEffect(() => saveMobileGeneratorView(view), [view]);

  useEffect(() => {
    useMobileGeneratorStore.setState({ showing: true });
    return () => useMobileGeneratorStore.setState({ showing: false });
  }, []);

  const submittedAt = useMobileGeneratorStore((state) => state.submittedAt);
  useEffect(() => {
    if (!submittedAt) return;
    generationGraphPanel.setView(resultsViewRef.current);
    resultsRef.current?.querySelector('.scroll-area')?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [submittedAt]);

  // The iOS keyboard shrinks only the visual viewport; lifting the bottom edge by it keeps the open
  // form's footer above the keyboard.
  const keyboardInset = useVisualViewportBottomInset();
  const challenges = !!useFeatureFlags().challengePlatform;
  const selecting = useSelectedCount() > 0;
  const headerHidden = useHideOnScroll(resultsRef, { resetKey: resultsView }) && !selecting;

  return (
    // The header and the form share one queue state.
    <GenerationProvider>
      <MobileGeneratorSlots>
        <div
          className={classes.root}
          style={{ '--generator-keyboard': `${keyboardInset}px` } as CSSProperties}
        >
          <header className={classes.header} data-hidden={headerHidden || undefined}>
            <div className={classes.headerFold}>
              <div className={classes.headerRow}>
                {selecting ? (
                  <div className="min-w-0 flex-1">
                    <GeneratedImageActions compact />
                  </div>
                ) : (
                  <>
                    {challenges && <ChallengeIndicator />}
                    <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
                      <Text fw={700} size="lg" className="truncate">
                        Generator
                      </Text>
                      <QueueCount />
                    </div>
                    <DensityToggle value={resultsView} />
                    <GeneratedImageActions compact />
                  </>
                )}
                <CloseButton
                  aria-label={closeLabel}
                  onClick={onClose}
                  size="lg"
                  variant="transparent"
                />
                <QueueSlots fill className="absolute inset-x-3 bottom-1.5" />
              </div>
            </div>
          </header>
          <div ref={resultsRef} className={classes.results} {...inert(expanded)}>
            <GenerationResults view={resultsView} />
          </div>
          <div
            data-scrim
            className={classes.scrim}
            data-visible={expanded || undefined}
            aria-hidden
          />
          <FormSheet expanded={expanded} onOpen={open} onClose={close}>
            {form}
          </FormSheet>
        </div>
      </MobileGeneratorSlots>
    </GenerationProvider>
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
  const presets = !!useFeatureFlags().generationPresets;
  const sheetRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; dy: number; pointerId: number; captured?: boolean }>();
  const [dragging, setDragging] = useState(false);
  // While a field takes typing, the footer steps aside so the keyboard leaves the field room.
  const [typing, setTyping] = useState(false);

  // The swipe coach: shown while the sheet is closed, until the form has been open once by any
  // route (Remix opens it too, and a coach after that first submit would cover the results).
  const [coach, setCoach] = useLocalStorage<'pending' | 'shown' | 'done'>({
    key: COACH_KEY,
    defaultValue: 'pending',
    getInitialValueInEffect: false,
  });
  useEffect(() => {
    if (expanded) {
      if (coach !== 'done') setCoach('done');
    } else if (coach === 'pending') setCoach('shown');
  }, [expanded, coach, setCoach]);

  const setDragOffset = (dy: number) =>
    sheetRef.current?.style.setProperty('--sheet-drag', `${dy}px`);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    // The closed bar is itself a button and drags too; the title row's buttons don't.
    if ((e.target as HTMLElement).closest('button:not([data-sheet-bar])')) return;
    drag.current = { startY: e.clientY, dy: 0, pointerId: e.pointerId };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== e.pointerId) return;
    const dy = expanded
      ? Math.max(0, e.clientY - current.startY)
      : Math.min(0, e.clientY - current.startY);
    current.dy = dy;
    if (Math.abs(dy) <= 4) return;
    // Captured only once it is a drag, so a tap stays a click on what it landed on: opening on the
    // tap's pointerup would re-render the row, and the click would land on the open form's chevron.
    if (!current.captured) {
      current.captured = true;
      // Throws for a pointer that is no longer down, which the drag can do without.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {}
    }
    if (!dragging) setDragging(true);
    setDragOffset(dy);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== e.pointerId) return;
    drag.current = undefined;
    setDragging(false);
    setDragOffset(0);
    // A tap opens through the bar's own click.
    if (expanded && current.dy > CLOSE_DRAG) onClose();
    else if (!expanded && current.dy < -OPEN_DRAG) onOpen();
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
      data-typing={typing || undefined}
      aria-label="Generation form"
    >
      {!expanded && coach === 'shown' && (
        // A tap on the bar also opens the form, for anyone who can't swipe.
        <div
          className={classes.coach}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          <div className={classes.coachCue} aria-hidden>
            <IconChevronsUp size={28} className={classes.coachArrow} />
            <IconHandFinger size={44} className={classes.coachFinger} />
          </div>
          <p className={classes.coachText} role="status">
            Swipe up to open the form
          </p>
        </div>
      )}
      <div
        className={classes.head}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {expanded ? (
          <div className={TITLE_ROW}>
            <SheetTitle />
            <div className="flex shrink-0 items-center gap-1">
              {presets && <PresetHeaderButton />}
              <RenderTitleActions className="contents" />
              <LegacyActionIcon
                aria-label="Close the form"
                variant="subtle"
                color="gray"
                size="lg"
                onClick={onClose}
              >
                <IconChevronDown size={20} />
              </LegacyActionIcon>
            </div>
          </div>
        ) : (
          <UnstyledButton
            data-sheet-bar
            className={clsx(TITLE_ROW, 'w-full text-left')}
            aria-label="Open the form"
            onClick={onOpen}
          >
            <SheetTitle />
            <span
              className={clsx(
                'flex size-[34px] shrink-0 items-center justify-center',
                coach === 'shown' && classes.nudge
              )}
            >
              <IconChevronUp size={20} />
            </span>
          </UnstyledButton>
        )}
      </div>
      <div
        className={classes.body}
        {...inert(!expanded)}
        onFocus={(e) => setTyping(isTextEntry(e.target))}
        onBlur={(e) => setTyping(isTextEntry(e.relatedTarget))}
      >
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

function DensityToggle({ value }: { value: GenerationResultsView }) {
  const next = value === 'queue' ? 'feed' : 'queue';
  const Icon = next === 'feed' ? IconLayoutGrid : IconLayoutList;
  return (
    <LegacyActionIcon
      aria-label={next === 'feed' ? 'Show as grid' : 'Show as batches'}
      variant="subtle"
      color="gray"
      size="lg"
      onClick={() => generationGraphPanel.setView(next)}
    >
      <Icon size={20} />
    </LegacyActionIcon>
  );
}

function QueueCount() {
  const { queued, requestLimit } = useGenerationContext((state) => state);
  if (!requestLimit) return null;
  return (
    <Badge
      variant="light"
      color={queued.length >= requestLimit ? 'yellow' : 'gray'}
      aria-label="Jobs in the queue"
    >
      {queued.length}/{requestLimit}
    </Badge>
  );
}

/** React 18 has no `inert` prop, so it is set as an attribute. */
const inert = (on: boolean) => (on ? ({ inert: '' } as object) : {});
