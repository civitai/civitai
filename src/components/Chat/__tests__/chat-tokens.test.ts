import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const chatDir = join(__dirname, '..');
const read = (file: string) => readFileSync(join(chatDir, file), 'utf8');

// Custom properties declared by the first rule whose selector list names `selector`.
function declaredIn(scss: string, selector: string) {
  const uncommented = scss.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = [...uncommented.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, selectors]) =>
    selectors.split(',').some((s) => s.trim() === selector)
  );
  if (!rule) return new Set<string>();
  return new Set([...rule[2].matchAll(/(--chat-[\w-]+)\s*:/g)].map((m) => m[1]));
}

const referenced = (css: string) =>
  new Set([...css.matchAll(/var\((--chat-[\w-]+)/g)].map((m) => m[1]));

describe('chat tokens outside the chat window', () => {
  const scss = read('Chat.module.scss');

  it('the .tokens rule declares every --chat-* var the chat list rows paint with', () => {
    const tokens = declaredIn(scss, '.tokens');
    const used = referenced(read('ChatList.module.css'));

    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((v) => !tokens.has(v))).toEqual([]);
  });

  it('.tokens carries the same palette as .surface', () => {
    expect(declaredIn(scss, '.tokens')).toEqual(declaredIn(scss, '.surface'));
  });

  it('ChatShareModal, which portals outside the window, puts its rows under .tokens', () => {
    expect(read('ChatShareModal.tsx')).toMatch(/content:\s*clsx\(chatClasses\.tokens\b/);
  });
});
