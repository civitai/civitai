import {
  selectedResourceIds,
  type SelectedResources,
} from '~/components/Generate/paid-access-gate';
import { anyTipEligible } from '~/shared/utils/creator-tip';

/** Whether the creator tip applies to this selection: some selected resource can receive a share. */
export function hasTipEligibleSelection(
  snapshot: SelectedResources,
  resourceData: { id: number; tipsEnabled?: boolean }[]
): boolean {
  return anyTipEligible(
    selectedResourceIds(snapshot).map((id) => resourceData.find((d) => d.id === id) ?? {})
  );
}
