import { Badge, CloseButton, Text, UnstyledButton } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import {
  IconChevronDown,
  IconChevronUp,
  IconLayoutGrid,
  IconLayoutList,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useField } from 'form-graph/react';
import type { CSSProperties, PointerEvent, ReactNode, RefObject } from 'react';
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
import { useHistoryLayer } from '~/hooks/useHistoryLayer';
import { useVisualViewportBottomInset } from '~/hooks/useVisualViewportBottomInset';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { workflowConfigByKey } from '~/shared/generation/config/workflows';
import { useActiveGenerationForm } from '~/store/active-generation-form.store';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import type { GenerationResultsView } from '~/store/generation-panel.store';
import { useMobileGeneratorStore } from '~/store/mobile-generator.store';
import classes from './MobileGenerator.module.scss';
import {
  MobileGeneratorSlots,
  RenderTitleActions,
} from '~/components/ImageGeneration/mobile-generator-slots';

const OPEN_DRAG = 24;
const CLOSE_DRAG = 60;
const HINT_KEY = 'mobile-generator-sheet-hint';
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
  const headerHidden = useHideOnScroll(resultsRef, resultsView) && !selecting;

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

  // First run: pending → shown when the sheet first closes (the chevron nudges, a hint shows); done
  // once it is opened from the bar.
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
    else if (!expanded && current.dy < -OPEN_DRAG) openFromBar();
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
            onClick={openFromBar}
          >
            <SheetTitle />
            <span
              className={clsx(
                'flex size-[34px] shrink-0 items-center justify-center',
                hint === 'shown' && classes.nudge
              )}
            >
              <IconChevronUp size={20} />
            </span>
          </UnstyledButton>
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

const HIDE_AFTER = 8;

/**
 * True while the results scroll down, false once they scroll back up or near the top, so the header
 * can make room. Listens in the capture phase, since the scrolling element is inside the results.
 */
function useHideOnScroll(ref: RefObject<HTMLElement>, resetKey: unknown) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    setHidden(false);
    const root = ref.current;
    if (!root) return;
    let lastY = 0;
    const onScroll = (e: Event) => {
      const y = (e.target as HTMLElement).scrollTop ?? 0;
      if (y < 56) {
        setHidden(false);
        lastY = y;
      } else if (Math.abs(y - lastY) > HIDE_AFTER) {
        setHidden(y > lastY);
        lastY = y;
      }
    };
    root.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => root.removeEventListener('scroll', onScroll, { capture: true });
  }, [ref, resetKey]);
  return hidden;
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
