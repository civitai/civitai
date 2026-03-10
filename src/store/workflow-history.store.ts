/**
 * Workflow History Store
 *
 * Tracks workflow/ecosystem navigation history within a session.
 * Supports back/forward navigation similar to browser history.
 * Persisted to sessionStorage so it survives page refreshes but not new tabs.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface WorkflowHistoryEntry {
  workflow: string;
  ecosystem: string;
}

interface WorkflowHistoryState {
  entries: WorkflowHistoryEntry[];
  index: number;
}

interface WorkflowHistoryStore extends WorkflowHistoryState {
  /** Push a new entry (truncates any forward entries). No-op if it matches current. */
  push: (entry: WorkflowHistoryEntry) => void;
  /** Move back and return the target entry, or undefined if at start. */
  back: () => WorkflowHistoryEntry | undefined;
  /** Move forward and return the target entry, or undefined if at end. */
  forward: () => WorkflowHistoryEntry | undefined;
  /** Get the entry before the current one without navigating. */
  peekBack: () => WorkflowHistoryEntry | undefined;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
}

export const useWorkflowHistoryStore = create<WorkflowHistoryStore>()(
  persist(
    (set, get) => ({
      entries: [],
      index: -1,

      push: (entry) => {
        const { entries, index } = get();
        const current = index >= 0 ? entries[index] : undefined;
        if (
          current &&
          current.workflow === entry.workflow &&
          current.ecosystem === entry.ecosystem
        ) {
          return;
        }
        const next = entries.slice(0, index + 1);
        next.push(entry);
        // Keep only the newest 10 entries
        if (next.length > 10) {
          const trimmed = next.slice(next.length - 10);
          set({ entries: trimmed, index: trimmed.length - 1 });
        } else {
          set({ entries: next, index: next.length - 1 });
        }
      },

      back: () => {
        const { entries, index } = get();
        if (index <= 0) return undefined;
        const newIndex = index - 1;
        set({ index: newIndex });
        return entries[newIndex];
      },

      forward: () => {
        const { entries, index } = get();
        if (index >= entries.length - 1) return undefined;
        const newIndex = index + 1;
        set({ index: newIndex });
        return entries[newIndex];
      },

      peekBack: () => {
        const { entries, index } = get();
        if (index <= 0) return undefined;
        return entries[index - 1];
      },

      canGoBack: () => get().index > 0,
      canGoForward: () => {
        const { entries, index } = get();
        return index < entries.length - 1;
      },
    }),
    {
      name: 'workflow-history',
      storage: createJSONStorage(() => sessionStorage),
      version: 1,
    }
  )
);
