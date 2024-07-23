import { kyselyDbRead, kyselyDbWrite } from '~/server/kysely-db';

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
