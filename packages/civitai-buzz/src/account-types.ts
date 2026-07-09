// Browser-safe (no fetch, no app deps): the buzz account-type model + the pure
// friendly↔API name map. The app's `BuzzTypes` (src/shared/constants/buzz.constants.ts)
// re-exports/delegates to these so there is a single source for the mapping, while the
// app keeps the UX config (buzzTypeConfig), spend/bank lists, and orchestrator mapping.

export const buzzApiAccountTypes = [
  'User',
  'Yellow',
  'Club',
  'Event',
  'Generation',
  'Blue',
  'Green',
  'FakeRed',
  'Other',
  // NOTE: in ClickHouse these are parsed as kebab-case.
  'CashPending',
  'CashSettled',
  'CreatorProgramBank',
  'CreatorProgramBankGreen',
] as const;
export type BuzzApiAccountType = (typeof buzzApiAccountTypes)[number];

export type BuzzSpendType = 'blue' | 'green' | 'yellow' | 'red';
export type BuzzCreatorProgramType = 'creatorProgramBank' | 'creatorProgramBankGreen';
export type BuzzCashType = 'cashPending' | 'cashSettled';
export type LegacyBuzzType = 'club';
export type BuzzAccountType =
  | BuzzSpendType
  | BuzzCreatorProgramType
  | BuzzCashType
  | LegacyBuzzType;

/** Canonical friendly→API account-type value map — the buzz service contract. */
export const clientToApiAccountType: Record<BuzzAccountType, BuzzApiAccountType> = {
  blue: 'Generation',
  green: 'Green',
  yellow: 'User',
  red: 'FakeRed',
  creatorProgramBank: 'CreatorProgramBank',
  creatorProgramBankGreen: 'CreatorProgramBankGreen',
  cashPending: 'CashPending',
  cashSettled: 'CashSettled',
  club: 'Club',
};

export const buzzAccountTypes = Object.keys(clientToApiAccountType) as BuzzAccountType[];

const apiTypesMap: Record<string, BuzzAccountType> = Object.fromEntries(
  buzzAccountTypes.flatMap((type) => {
    const apiValue = clientToApiAccountType[type];
    return [
      [apiValue, type],
      [apiValue.toLowerCase(), type],
      [type, type],
    ];
  })
);

export function toApiType(type: BuzzAccountType): BuzzApiAccountType {
  return clientToApiAccountType[type] ?? (type as unknown as BuzzApiAccountType);
}

export function toClientType(value: string): BuzzAccountType {
  if (!(value in apiTypesMap)) throw new Error(`unsupported buzz type: ${value}`);
  return apiTypesMap[value];
}

/** Map a transaction's friendly from/to account types to their buzz-API values. */
export function toApiTransaction<
  T extends { fromAccountType?: BuzzAccountType; toAccountType?: BuzzAccountType }
>(transaction: T) {
  return {
    ...transaction,
    fromAccountType: transaction.fromAccountType
      ? toApiType(transaction.fromAccountType)
      : undefined,
    toAccountType: transaction.toAccountType ? toApiType(transaction.toAccountType) : undefined,
  };
}
