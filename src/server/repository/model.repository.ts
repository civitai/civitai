import { Expression } from 'kysely';
import { kyselyDbRead } from '~/server/kysely-db';

export class ModelRepository {
  // #region [helpers]
  static getCountByUserIdRef(foreignKey: Expression<number>) {
    return kyselyDbRead
      .selectFrom('Model')
      .select((eb) => [eb.fn.countAll<number>().as('count')])
      .whereRef('Model.userId', '=', foreignKey);
  }
  // #endregion
}
