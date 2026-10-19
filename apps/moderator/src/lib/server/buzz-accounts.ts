/** Account types whose id is a real `User.id`. Every other type (banks, cash, Creator Program pools)
 *  transacts in the same integer space without being a user: `creatorProgramBank` uses ids that
 *  belong to unrelated real accounts, so reading those as users names an innocent creator. */
export const USER_ACCOUNT_TYPES = ['user', 'yellow', 'generation', 'blue', 'green'] as const;

export const USER_ACCOUNT_TYPES_SQL = USER_ACCOUNT_TYPES.map((t) => `'${t}'`).join(',');
