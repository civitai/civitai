import { IconEyeOff } from '@tabler/icons-react';
import { Node } from '@tiptap/core';
import clsx from 'clsx';
import type { KeyboardEvent, ReactNode } from 'react';
import { useState } from 'react';
import classes from './RichTextEditorComponent.module.scss';

// React 18 has no `inert` prop; the empty string is how it reaches the DOM as a boolean attribute.
const inertWhile = (hidden: boolean) => (hidden ? ({ inert: '' } as object) : {});

const SPOILER_RUN = 'spoilerRun';

/** Render-only: one reveal target for a spoiler that spans several differently-formatted texts. */
export const SpoilerRunNode = Node.create({
  name: SPOILER_RUN,
  group: 'inline',
  inline: true,
  content: 'inline*',
});

type JsonNode = {
  type?: string;
  marks?: { type?: string }[];
  content?: JsonNode[];
  [key: string]: unknown;
};

/**
 * The static renderer wraps each text node in its own marks, so `||a **b** c||` would come out as
 * three spoilers revealed one at a time. Gathers each unbroken run of spoiler-marked nodes under
 * one `spoilerRun` instead.
 */
export function groupSpoilerRuns(node: JsonNode): JsonNode {
  if (!node || typeof node !== 'object' || !Array.isArray(node.content)) return node;
  const content: JsonNode[] = [];
  let run: JsonNode[] | null = null;
  for (const child of node.content.map(groupSpoilerRuns)) {
    const marks = child?.marks ?? [];
    if (!marks.some((mark) => mark?.type === 'spoiler')) {
      run = null;
      content.push(child);
      continue;
    }
    const { marks: _marks, ...rest } = child;
    const others = marks.filter((mark) => mark?.type !== 'spoiler');
    if (!run) {
      run = [];
      content.push({ type: SPOILER_RUN, content: run });
    }
    run.push(others.length ? { ...rest, marks: others } : rest);
  }
  return { ...node, content };
}

export function SpoilerText({ children }: { children?: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  const reveal = () => setRevealed(true);
  const onKeyDown = (event: KeyboardEvent) => {
    if (revealed || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    reveal();
  };

  return (
    <span
      data-type="spoiler"
      role={revealed ? undefined : 'button'}
      // -1 once revealed, so the reader's focus stays put instead of dropping to the page.
      tabIndex={revealed ? -1 : 0}
      aria-label={revealed ? undefined : 'Spoiler, hidden text. Activate to reveal.'}
      onClick={reveal}
      onKeyDown={onKeyDown}
      className={clsx(classes.spoilerText, !revealed && classes.spoilerTextHidden)}
    >
      <span aria-hidden={revealed ? undefined : true} {...inertWhile(!revealed)}>
        {children}
      </span>
    </span>
  );
}

// Sits inside whatever gate already covers the body (the article's own NSFW gate, an embedded
// card's image guard): revealing it lifts the spoiler and nothing else.
export function SpoilerBlock({ children }: { children?: ReactNode }) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div data-type="spoiler" className={classes.spoilerBlock}>
      <div
        className={clsx(!revealed && classes.spoilerBlockHidden)}
        aria-hidden={revealed ? undefined : true}
        {...inertWhile(!revealed)}
      >
        {children}
      </div>
      {!revealed && (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="absolute inset-0 flex size-full cursor-pointer items-center justify-center"
        >
          <span className="flex items-center gap-1.5 rounded-md bg-black/70 px-3 py-1.5 text-sm font-semibold text-white">
            <IconEyeOff size={16} aria-hidden />
            Spoiler, click to reveal
          </span>
        </button>
      )}
    </div>
  );
}
