import { Kysely, SelectExpression, SelectQueryBuilder } from 'kysely';
import { ExtractTableAlias } from 'kysely/dist/cjs/parser/table-parser';
import { DB, kyselyDbRead, kyselyDbWrite } from '~/server/kysely-db';

// TODO - logging

export class Repository {
  protected dbRead = kyselyDbRead;
  protected dbWrite = kyselyDbWrite;

  // protected findOne(id: number) {
  //   throw new Error('Method not implemented.');
  // }

  // protected findMany(ids: number[]) {
  //   throw new Error('Method not implemented.');
  // }
}

class BaseRepository {
  protected dbRead = kyselyDbRead;
  protected dbWrite = kyselyDbWrite;
}

export function derived<
  TB extends keyof DB,
  TObject extends Record<string, unknown>,
  TSelect extends SelectQueryBuilder<DB, TB, TObject>,
  TViews extends Record<string, TSelect>
>({ views }: { table: TB; views: TViews }) {
  class Derived {
    protected _views = views;

    protected buildSelect<TKey extends keyof TViews>({ select }: { select: TKey }) {
      return this._views[select];
    }
  }
  return Derived;
}

// type Callback<TViews> = (args: { dbRead: Kysely<DB>; dbWrite: Kysely<DB> }) => TViews;

// export function repository<TB extends keyof DB, TSelectFrom extends Kysely<DB>['selectFrom']>({
//   table,
// }: {
//   table: TB;
// }) {
//   class Repository extends BaseRepository {
//     test() {
//       this.dbRead.selectFrom(table).select();
//     }
//   }
// }
