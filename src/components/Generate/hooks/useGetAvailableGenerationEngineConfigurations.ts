import { useGetGenerationEngines } from '~/components/Generate/hooks/useGetGenerationEngines';
import { generationFormWorkflowConfigurations } from '~/shared/constants/generation.constants';

export function useGetAvailableGenerationEngineConfigurations() {
  const { data, ...rest } = useGetGenerationEngines();
  console.log({ data });

  return {
    data: data
      ?.filter((x) => !x.disabled)
      .flatMap(({ engine }) =>
        generationFormWorkflowConfigurations.filter((x) => x.engine === engine)
      ),
    ...rest,
  };
}
