/**
 * Workflow Preferences Store
 *
 * Tracks the user's most recently used ecosystem (baseModel) for each workflow.
 * Used to determine target ecosystem when switching between workflows.
 * Each entry includes a timestamp for recency-based lookups.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isEnhancementWorkflow } from '~/shared/data-graph/generation/config/workflows';

interface WorkflowPreferenceEntry {
  ecosystem: string;
  timestamp: number;
}

interface WorkflowPreferencesState {
  /** Most recently used ecosystem key (with timestamp) for each workflow */
  ecosystemByWorkflow: Record<string, WorkflowPreferenceEntry>;
  /** Update the preferred ecosystem for a workflow */
  setPreferredEcosystem: (workflowId: string, ecosystemKey: string) => void;
  /** Get the preferred ecosystem for a workflow */
  getPreferredEcosystem: (workflowId: string) => string | undefined;
  /** Get the most recently used non-enhancement workflow + ecosystem */
  getLastUsedWorkflow: () => { workflow: string; ecosystem: string } | undefined;
}

export const useWorkflowPreferencesStore = create<WorkflowPreferencesState>()(
  persist(
    (set, get) => ({
      ecosystemByWorkflow: {},

      setPreferredEcosystem: (workflowId, ecosystemKey) => {
        set((state) => ({
          ecosystemByWorkflow: {
            ...state.ecosystemByWorkflow,
            [workflowId]: { ecosystem: ecosystemKey, timestamp: Date.now() },
          },
        }));
      },

      getPreferredEcosystem: (workflowId) => {
        return get().ecosystemByWorkflow[workflowId]?.ecosystem;
      },

      getLastUsedWorkflow: () => {
        const entries = Object.entries(get().ecosystemByWorkflow);
        let best: { workflow: string; ecosystem: string; timestamp: number } | undefined;
        for (const [workflowId, entry] of entries) {
          if (isEnhancementWorkflow(workflowId)) continue;
          if (!best || entry.timestamp > best.timestamp) {
            best = { workflow: workflowId, ecosystem: entry.ecosystem, timestamp: entry.timestamp };
          }
        }
        return best ? { workflow: best.workflow, ecosystem: best.ecosystem } : undefined;
      },
    }),
    {
      name: 'workflow-preferences',
      version: 3,
      migrate: (persisted: any, version: number) => {
        if (version < 3) {
          // v2 stored plain strings: Record<string, string>
          // v3 stores objects: Record<string, { ecosystem: string; timestamp: number }>
          const old = persisted?.ecosystemByWorkflow as Record<string, string> | undefined;
          const migrated: Record<string, WorkflowPreferenceEntry> = {};
          if (old) {
            for (const [key, value] of Object.entries(old)) {
              if (typeof value === 'string') {
                migrated[key] = { ecosystem: value, timestamp: 0 };
              }
            }
          }
          return { ...persisted, ecosystemByWorkflow: migrated };
        }
        return persisted as WorkflowPreferencesState;
      },
    }
  )
);

/** Standalone accessor for use outside React components */
export const workflowPreferences = {
  setPreferredEcosystem: (workflowId: string, ecosystemKey: string) => {
    useWorkflowPreferencesStore.getState().setPreferredEcosystem(workflowId, ecosystemKey);
  },
  getPreferredEcosystem: (workflowId: string) => {
    return useWorkflowPreferencesStore.getState().getPreferredEcosystem(workflowId);
  },
  getLastUsedWorkflow: () => {
    return useWorkflowPreferencesStore.getState().getLastUsedWorkflow();
  },
};
