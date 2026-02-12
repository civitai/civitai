import { Button, Textarea, type TextareaProps } from '@mantine/core';
import { getHotkeyHandler } from '@mantine/hooks';
import { IconSparkles } from '@tabler/icons-react';
import type { ClipboardEvent, KeyboardEvent } from 'react';
import { useState } from 'react';
import { create } from 'zustand';

import { extractCivitaiMetadata, parsePromptMetadata } from '~/utils/metadata';

// Store to track prompt focus state for whatIf debouncing
export const usePromptFocusedStore = create<{ focused: boolean }>(() => ({ focused: false }));

export type PromptInputProps = Omit<TextareaProps, 'onChange'> & {
  onChange?: (value: string) => void;
  onFillForm?: (metadata: Record<string, unknown>) => void;
};

export function PromptInput({ onFillForm, ...props }: PromptInputProps) {
  const [showFillForm, setShowFillForm] = useState(false);
  const [pastedMetadata, setPastedMetadata] = useState<Record<string, unknown> | null>(null);

  function handleArrowUpOrDown(event: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent) {
    if (props.name) {
      const text = keyupEditAttention(event as React.KeyboardEvent<HTMLTextAreaElement>);
      props.onChange?.(text ?? '');
    }
  }

  const keyHandler = getHotkeyHandler([
    // ['mod+Enter', handleSubmit],
    ['mod+ArrowUp', handleArrowUpOrDown],
    ['mod+ArrowDown', handleArrowUpOrDown],
  ]);

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (!onFillForm) return;

    // Check for structured Civitai metadata in the HTML clipboard
    const html = e.clipboardData?.getData('text/html');
    if (html) {
      const metadata = extractCivitaiMetadata(html);
      if (metadata) {
        setPastedMetadata(metadata);
        setShowFillForm(true);
        return;
      }
    }

    // Fall back to text-based detection for external sources
    const text = e.clipboardData?.getData('text/plain');
    if (text) {
      setPastedMetadata(null);
      setShowFillForm(text.includes('Steps:'));
    }
  }

  function handleFillForm() {
    if (pastedMetadata) {
      onFillForm?.(pastedMetadata);
    } else {
      const metadata = parsePromptMetadata(String(props.value ?? ''));
      onFillForm?.(metadata);
    }
    setShowFillForm(false);
    setPastedMetadata(null);
  }

  return (
    <div className="relative">
      <Textarea
        {...props}
        onChange={(e) => props.onChange?.(e.target.value)}
        onKeyDown={keyHandler}
        onPaste={handlePaste}
        onFocus={() => usePromptFocusedStore.setState({ focused: true })}
        onBlur={() => usePromptFocusedStore.setState({ focused: false })}
      />
      {showFillForm && (
        <Button
          size="compact-xs"
          leftSection={<IconSparkles size={14} />}
          onClick={handleFillForm}
          className="absolute right-2 top-2"
        >
          Fill Form
        </Button>
      )}
    </div>
  );
}

/**
 * Taken from stable-diffusion-webui github repo and modified to fit our needs
 * @see https://github.com/AUTOMATIC1111/stable-diffusion-webui/blob/master/javascript/edit-attention.js
 */
const DELIMETERS = '.,\\/!?%^*;:{}=`~()\r\n\t';
export function keyupEditAttention(event: React.KeyboardEvent<HTMLTextAreaElement>) {
  const target = event.target as HTMLTextAreaElement;
  if (!(event.metaKey || event.ctrlKey)) return;

  const isPlus = event.key == 'ArrowUp';
  const isMinus = event.key == 'ArrowDown';
  if (!isPlus && !isMinus) return;

  let selectionStart = target.selectionStart;
  let selectionEnd = target.selectionEnd;
  let text = target.value;

  function selectCurrentParenthesisBlock(OPEN: string, CLOSE: string) {
    if (selectionStart !== selectionEnd) return false;

    // Find opening parenthesis around current cursor
    const before = text.substring(0, selectionStart);
    let beforeParen = before.lastIndexOf(OPEN);
    if (beforeParen == -1) return false;
    let beforeParenClose = before.lastIndexOf(CLOSE);
    while (beforeParenClose !== -1 && beforeParenClose > beforeParen) {
      beforeParen = before.lastIndexOf(OPEN, beforeParen - 1);
      beforeParenClose = before.lastIndexOf(CLOSE, beforeParenClose - 1);
    }

    // Find closing parenthesis around current cursor
    const after = text.substring(selectionStart);
    let afterParen = after.indexOf(CLOSE);
    if (afterParen == -1) return false;
    let afterParenOpen = after.indexOf(OPEN);
    while (afterParenOpen !== -1 && afterParen > afterParenOpen) {
      afterParen = after.indexOf(CLOSE, afterParen + 1);
      afterParenOpen = after.indexOf(OPEN, afterParenOpen + 1);
    }
    if (beforeParen === -1 || afterParen === -1) return false;

    // Set the selection to the text between the parenthesis
    const parenContent = text.substring(beforeParen + 1, selectionStart + afterParen);
    const lastColon = parenContent.lastIndexOf(':');
    selectionStart = beforeParen + 1;
    selectionEnd = selectionStart + lastColon;
    target.setSelectionRange(selectionStart, selectionEnd);
    return true;
  }

  function selectCurrentWord() {
    if (selectionStart !== selectionEnd) return false;

    // seek backward until to find beggining
    while (!DELIMETERS.includes(text[selectionStart - 1]) && selectionStart > 0) {
      selectionStart--;
    }

    // seek forward to find end
    while (!DELIMETERS.includes(text[selectionEnd]) && selectionEnd < text.length) {
      selectionEnd++;
    }

    target.setSelectionRange(selectionStart, selectionEnd);
    return true;
  }

  // If the user hasn't selected anything, let's select their current parenthesis block or word
  if (!selectCurrentParenthesisBlock('<', '>') && !selectCurrentParenthesisBlock('(', ')')) {
    selectCurrentWord();
  }

  event.preventDefault();

  let closeCharacter = ')';
  let delta = 0.1;

  if (selectionStart > 0 && text[selectionStart - 1] == '<') {
    closeCharacter = '>';
    delta = 0.05;
  } else if (selectionStart == 0 || text[selectionStart - 1] != '(') {
    // do not include spaces at the end
    while (selectionEnd > selectionStart && text[selectionEnd - 1] == ' ') {
      selectionEnd -= 1;
    }
    if (selectionStart == selectionEnd) {
      return;
    }

    text =
      text.slice(0, selectionStart) +
      '(' +
      text.slice(selectionStart, selectionEnd) +
      ':1.0)' +
      text.slice(selectionEnd);

    selectionStart += 1;
    selectionEnd += 1;
  }

  const end = text.slice(selectionEnd + 1).indexOf(closeCharacter) + 1;
  let weight = parseFloat(text.slice(selectionEnd + 1, selectionEnd + 1 + end));
  if (isNaN(weight)) return;

  weight += isPlus ? delta : -delta;
  weight = parseFloat(weight.toPrecision(12));

  if (closeCharacter == ')' && weight === 1) {
    const endParenPos = text.substring(selectionEnd).indexOf(')');
    text =
      text.slice(0, selectionStart - 1) +
      text.slice(selectionStart, selectionEnd) +
      text.slice(selectionEnd + endParenPos + 1);
    selectionStart--;
    selectionEnd--;
  } else {
    text = text.slice(0, selectionEnd + 1) + weight + text.slice(selectionEnd + end);
  }

  target.focus();
  target.value = text;
  target.selectionStart = selectionStart;
  target.selectionEnd = selectionEnd;

  return text;
}
