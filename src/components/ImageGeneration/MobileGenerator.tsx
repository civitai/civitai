import { Badge, Button, CloseButton, Text } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { IconChevronDown, IconLayoutGrid, IconLayoutList, IconPlus } from '@tabler/icons-react';
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
import {
  useKeyboardOpen,
  useVisualViewportBottomInset,
} from '~/hooks/useVisualViewportBottomInset';
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
/**
 * How long the footer waits to come back after a field loses focus. A tap blurs the field on its
 * mousedown, before its click: a footer back at once takes the click meant for what was under it.
 */
const FOOTER_RETURN_MS = 300;

const CLOSE_DRAG = 60;
const TITLE_ROW = 'flex min-h-12 items-center gap-2 px-3';

type Props = { form: ReactNode; onClose: () => void; closeLabel: string };

/**
 * The generator on a phone: the results are the screen, and the form is a bottom sheet over them,
 * opened by a floating Create button.
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

  // The iOS keyboard shrinks only the visual viewport; lifting the bottom edge by it keeps the open
  // form's footer above the keyboard.
  const keyboardInset = useVisualViewportBottomInset();
  // The results start below the header lying over them, however tall it renders.
  const { ref: headerRef, height: headerHeight } = useElementSize();
  const challenges = !!useFeatureFlags().challengePlatform;
  const selecting = useSelectedCount() > 0;
  const headerHidden = useHideOnScroll(resultsRef, { resetKey: resultsView }) && !selecting;

  return (
    // The header and the form share one queue state.
    <GenerationProvider>
      <MobileGeneratorSlots>
        <div
          className={classes.root}
          style={
            {
              '--generator-keyboard': `${keyboardInset}px`,
              ...(headerHeight > 0 && { '--generator-header': `${headerHeight}px` }),
            } as CSSProperties
          }
        >
          <header
            ref={headerRef}
            className={classes.header}
            data-hidden={headerHidden || undefined}
          >
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
          </header>
          <div ref={resultsRef} className={classes.results} {...inert(expanded)}>
            <GenerationResults view={resultsView} className={classes.resultsScroll} />
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
  // While a field takes typing with the keyboard up, the footer steps aside so the keyboard leaves
  // the field room. With the keyboard down (dismissed, or a hardware one) the footer stays.
  const [typing, setTyping] = useState(false);
  const keyboardOpen = useKeyboardOpen();
  const footerReturn = useRef<ReturnType<typeof setTimeout>>();
  const setTypingFor = (field: EventTarget | null) => {
    clearTimeout(footerReturn.current);
    if (isTextEntry(field)) setTyping(true);
    else footerReturn.current = setTimeout(() => setTyping(false), FOOTER_RETURN_MS);
  };
  useEffect(() => () => clearTimeout(footerReturn.current), []);

  const setDragOffset = (dy: number) =>
    sheetRef.current?.style.setProperty('--sheet-drag', `${dy}px`);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    // The title row's buttons don't drag.
    if ((e.target as HTMLElement).closest('button')) return;
    drag.current = { startY: e.clientY, dy: 0, pointerId: e.pointerId };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== e.pointerId) return;
    const dy = Math.max(0, e.clientY - current.startY);
    current.dy = dy;
    if (Math.abs(dy) <= 4) return;
    // Captured only once it is a drag, so a tap stays a click on what it landed on.
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
    if (current.dy > CLOSE_DRAG) onClose();
  };
  const onPointerCancel = () => {
    drag.current = undefined;
    setDragging(false);
    setDragOffset(0);
  };

  return (
    <>
      <section
        ref={sheetRef}
        className={classes.sheet}
        data-expanded={expanded || undefined}
        data-dragging={dragging || undefined}
        data-typing={(typing && keyboardOpen) || undefined}
        aria-label="Generation form"
        {...inert(!expanded)}
      >
        <div
          className={classes.head}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          <div className={TITLE_ROW}>
            <SheetTitle />
            {expanded && (
              <div className="flex shrink-0 items-center gap-1">
                {presets && <PresetHeaderButton />}
                <RenderTitleActions className="contents" />
                <CloseFormButton onClose={onClose} />
              </div>
            )}
          </div>
        </div>
        <div
          className={classes.body}
          onFocus={(e) => setTypingFor(e.target)}
          onBlur={(e) => setTypingFor(e.relatedTarget)}
        >
          {children}
        </div>
      </section>
      {!expanded && (
        <Button
          data-pill
          className={classes.create}
          leftSection={<IconPlus size={20} />}
          h={56}
          fz={16}
          onClick={onOpen}
        >
          Create
        </Button>
      )}
    </>
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

/** The open form's down chevron. While jobs run it spins and counts them: closing shows them. */
function CloseFormButton({ onClose }: { onClose: () => void }) {
  const running = useGenerationContext((state) => state.queued.length);
  return (
    <LegacyActionIcon
      aria-label={running ? `Close the form, ${running} generating` : 'Close the form'}
      variant="subtle"
      color="gray"
      size="lg"
      onClick={onClose}
      className={classes.closeForm}
      data-running={running || undefined}
    >
      <IconChevronDown size={20} />
      {running > 0 && (
        <span className={classes.runningCount} aria-hidden>
          {running}
        </span>
      )}
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
