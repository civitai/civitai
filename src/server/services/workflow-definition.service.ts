import { dbRead, dbWrite } from '~/server/db/client';
import {
  CreateWorkflowDefinitionSchema,
  UpdateWorkflowDefinitionSchema,
} from '../schema/workflow-definition.schema';

export async function getWorkflowDefinitions() {
  return await dbRead.workflowDefinition.findMany({
    orderBy: { index: 'asc' },
  });
}

export async function createWorkflowDefinition(data: CreateWorkflowDefinitionSchema) {
  return await dbWrite.workflowDefinition.create({ data });
}

export async function updateWorkflowDefinition({ id, ...data }: UpdateWorkflowDefinitionSchema) {
  return await dbWrite.workflowDefinition.update({ where: { id: id }, data });
}

export async function deleteWorkflowDefinition(id: number) {
  await dbWrite.workflowDefinition.delete({ where: { id } });
}

export async function reorderWorkflowDefinitions({ ids }: { ids: number[] }) {
  await dbWrite.$queryRaw`
    UPDATE "WorkflowDefinition" AS wd SET
      index = wd2.index
    FROM (
      VALUES ${ids.map((id, index) => `(${id}, ${index})`)}
    ) AS wd2(id, index)
    WHERE wd2.id = wd.id;
  `;
}
