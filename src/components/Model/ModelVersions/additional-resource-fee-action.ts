export function getAdditionalResourceFeeAction(waived: boolean) {
  return waived
    ? {
        label: 'Charge additional resource fee',
        message:
          'Generations using this version will be charged the additional resource fee again.',
        next: false,
      }
    : {
        label: 'Waive additional resource fee',
        message:
          'Generations using this version will no longer be charged the additional resource fee.',
        next: true,
      };
}
