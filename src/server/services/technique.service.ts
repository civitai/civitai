import { dbRead } from '~/server/db/client';

export type TechniqueModel = AsyncReturnType<typeof getAllTechniques>[number];
export async function getAllTechniques() {
  return await dbRead.technique.findMany({
    select: {
      id: true,
      name: true,
      type: true,
    },
  });
}

export async function getTechniqueByName(name: string) {
  return dbRead.technique.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  });
}

/**
 * A generation workflow key's technique: its variant when that is a technique of its own
 * ('img2vid:ref2vid' → ref2vid), otherwise its base ('img2img:hires-fix' → img2img).
 */
export async function getTechniqueForWorkflow(workflow: string) {
  const [base, variant] = workflow.split(':');
  return (variant && (await getTechniqueByName(variant))) || getTechniqueByName(base);
}
