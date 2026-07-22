import { writable } from 'svelte/store';
import { browser } from '$app/environment';

// Which base models the creator has pinned on the Civitai-wide usage chart, persisted so the choice survives
// navigation + sessions. Empty = "not chosen yet" — the page falls back to a sensible default (the top few).
const KEY = 'cs-basemodel-trend';

function initial(): string[] {
  if (!browser) return [];
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export const baseModelTrendSelection = writable<string[]>(initial());

if (browser) {
  baseModelTrendSelection.subscribe((v) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(v));
    } catch {
      /* private mode / storage disabled — preference just won't persist */
    }
  });
}
