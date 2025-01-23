import { reorderByIdsSchema } from '~/server/schema/base.schema';
import {
  createWorkflowDefinitionSchema,
  updateWorkflowDefinitionSchema,
} from '~/server/schema/workflow-definition.schema';
import {
  createWorkflowDefinition,
  getWorkflowDefinitions,
  updateWorkflowDefinition,
  reorderWorkflowDefinitions,
} from '~/server/services/workflow-definition.service';
import { moderatorProcedure, publicProcedure, router } from '~/server/trpc';

export const workflowDefinitionRouter = router({
  getWorkflowDefinitions: publicProcedure.query(() => getWorkflowDefinitions()),
  createWorkflowDefinition: moderatorProcedure
    .input(createWorkflowDefinitionSchema)
    .mutation(({ input }) => createWorkflowDefinition(input)),
  updateWorkflowDefinition: moderatorProcedure
    .input(updateWorkflowDefinitionSchema)
    .mutation(({ input }) => updateWorkflowDefinition(input)),
  reorderWorkflowDefinitions: moderatorProcedure
    .input(reorderByIdsSchema)
    .mutation(({ input }) => reorderWorkflowDefinitions(input)),
});
