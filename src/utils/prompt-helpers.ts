import { ModelType } from '@prisma/client';

const p = {
  textualInversion: `[\\w\\_\\.-]+`,
  fileName: `[\\w\\_\\.-]+`,
  strength: `[0-9.]+`,
};

const regexSplitPatterns = {
  lora: `<lora:${p.fileName}:${p.strength}>`,
  lyco: `<lyco:${p.fileName}:${p.strength}>`,
  textualInversion: `#${p.textualInversion}`,
};
const splitRegExp = new RegExp(`(${Object.values(regexSplitPatterns).join('|')})`, 'g');

const regexGroupPatterns = {
  assertion: /<(lora|lyco):([a-zA-Z0-9_\.-]+):([0-9.]+)>/g,
  textualInversion: /#([a-zA-Z0-9_\.-]+)/g,
};

type PromptResource = {
  type: ModelType;
  name: string;
  strength?: string;
};

type PromptResourceType = 'lora' | 'lyco';
const typeConversions: Record<PromptResourceType, ModelType> = {
  lora: ModelType.LORA,
  lyco: ModelType.LoCon,
};

const convertType = (type: string) => {
  return typeConversions[type as PromptResourceType];
};

export const splitPromptResources = (value: string) => {
  return value.split(splitRegExp);
};

export const parsePromptResources = (value: string) => {
  const assertions = [...value.matchAll(regexGroupPatterns.assertion)].reduce<PromptResource[]>(
    (acc, [, type, name, strength]) => [
      ...acc,
      { type: convertType(type), name, strength } as PromptResource,
    ],
    []
  );
  const textualInversions = [...value.matchAll(regexGroupPatterns.textualInversion)].map(
    ([, name]) => ({
      type: ModelType.TextualInversion,
      name,
    })
  ) as PromptResource[];
  return [...assertions, ...textualInversions];
};
