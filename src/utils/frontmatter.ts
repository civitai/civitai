import { load } from 'js-yaml';

const FRONTMATTER = /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** Splits a leading `---` YAML block off a markdown document. */
export function parseFrontmatter(source: string) {
  const match = FRONTMATTER.exec(source);
  if (!match) return { data: {} as Record<string, any>, content: source };
  const data = match[1] ? load(match[1]) : undefined;
  return {
    data: (data && typeof data === 'object' ? data : {}) as Record<string, any>,
    content: source.slice(match[0].length),
  };
}
