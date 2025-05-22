import { createSelectStore } from '~/store/select.store';

type OrchestratorImageSelectArgs = { workflowId: string; stepName: string; imageId: string };

const stringify = ({ workflowId, stepName, imageId }: OrchestratorImageSelectArgs) =>
  `${workflowId}:${stepName}:${imageId}`;

const parseValue = (value: string) => {
  const [workflowId, stepName, imageId] = value.split(':') as [
    workflowId: string,
    stepName: string,
    imageId: string
  ];
  return { workflowId, stepName, imageId };
};

const selectStore = createSelectStore<string>('generated-image-select');
export const orchestratorImageSelect = {
  useSelection: () => {
    return selectStore.useSelection().map(parseValue);
  },
  useIsSelected: (args: OrchestratorImageSelectArgs) => {
    return selectStore.useIsSelected(stringify(args));
  },
  useIsSelecting: selectStore.useIsSelecting,
  setSelected: (args: OrchestratorImageSelectArgs[]) => {
    return selectStore.setSelected(args.map(stringify));
  },
  toggle: (args: OrchestratorImageSelectArgs, value?: boolean) => {
    return selectStore.toggle(stringify(args), value);
  },
  getSelected: () => {
    return selectStore.getSelected().map(parseValue);
  },
};
