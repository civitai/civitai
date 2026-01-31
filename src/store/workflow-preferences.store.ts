/**
 * Workflow Preferences Store
 *
 * Tracks the user's most recently used ecosystem (baseModel) for each workflow.
 * Used to determine target ecosystem when switching between workflows.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface WorkflowPreferencesState {
  /** Most recently used ecosystem key for each workflow */
  ecosystemByWorkflow: Record<string, string>;
  /** Update the preferred ecosystem for a workflow */
  setPreferredEcosystem: (workflowId: string, ecosystemKey: string) => void;
  /** Get the preferred ecosystem for a workflow */
  getPreferredEcosystem: (workflowId: string) => string | undefined;
}

export const useWorkflowPreferencesStore = create<WorkflowPreferencesState>()(
  persist(
    (set, get) => ({
      ecosystemByWorkflow: {},

      setPreferredEcosystem: (workflowId, ecosystemKey) => {
        set((state) => ({
          ecosystemByWorkflow: {
            ...state.ecosystemByWorkflow,
            [workflowId]: ecosystemKey,
          },
        }));
      },

      getPreferredEcosystem: (workflowId) => {
        return get().ecosystemByWorkflow[workflowId];
      },
    }),
    {
      name: 'workflow-preferences',
      version: 2, // Bump version since schema changed
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
};
