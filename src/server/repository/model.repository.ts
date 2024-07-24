import { Expression } from 'kysely';
import { Repository } from '~/server/repository/infrastructure/repository';

class ModelRepository extends Repository {
  getCountByUserIdRef(foreignKey: Expression<number>) {
    return this.dbRead
      .selectFrom('Model')
      .select((eb) => [eb.fn.countAll<number>().as('count')])
      .whereRef('Model.userId', '=', foreignKey);
  }
}

export const modelRepository = new ModelRepository();
