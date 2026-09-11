import { useMemo } from 'react';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { BaseModelWarningPoints } from '~/components/Model/BaseModelWarningAlert/BaseModelWarningAlert';
import { getBaseModelWarning } from '~/shared/constants/base-model-warnings.constants';
import { ecosystemByKey, getBaseModelsByEcosystemId } from '~/shared/constants/basemodel.constants';

export function EcosystemBaseModelWarnings({ ecosystem }: { ecosystem?: string }) {
  const warnings = useMemo(() => {
    const ecosystemId = ecosystem ? ecosystemByKey.get(ecosystem)?.id : undefined;
    if (ecosystemId == null) return [];
    return getBaseModelsByEcosystemId(ecosystemId).flatMap((baseModel) => {
      const warning = getBaseModelWarning(baseModel.name);
      return warning ? [{ baseModel: baseModel.name, warning }] : [];
    });
  }, [ecosystem]);

  if (!warnings.length) return null;

  return (
    <>
      {warnings.map(({ baseModel, warning }) => (
        <DismissibleAlert
          key={baseModel}
          id={`base-model-warning-${baseModel}`}
          color="red"
          size="sm"
          title={warning.title}
        >
          <BaseModelWarningPoints points={warning.points} />
        </DismissibleAlert>
      ))}
    </>
  );
}
