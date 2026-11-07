import type { PartnerDisclosure } from '~/shared/constants/model-version-flags.constants';

type PartnerAction = { label: string; message: string; next: PartnerDisclosure };

export function getPartnerServiceAction({ partnerService }: PartnerDisclosure): PartnerAction {
  return partnerService
    ? {
        label: 'Clear partner service',
        message: 'The generator stops showing the partner icons on this version.',
        next: { partnerService: false, partnerTrains: false },
      }
    : {
        label: 'Mark partner service',
        message: 'The generator shows the partner icon on this version.',
        next: { partnerService: true, partnerTrains: false },
      };
}

export function getPartnerTrainsAction({ partnerTrains }: PartnerDisclosure): PartnerAction {
  return partnerTrains
    ? {
        label: 'Clear partner trains',
        message: 'The generator stops showing the training icon. The partner icon stays.',
        next: { partnerService: true, partnerTrains: false },
      }
    : {
        label: 'Mark partner trains',
        message: 'The generator shows the partner and training icons on this version.',
        next: { partnerService: true, partnerTrains: true },
      };
}
