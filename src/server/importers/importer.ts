import { ImportStatus } from '@prisma/client';

type Importer = {
  canHandle: (source: string) => boolean;
  run: (id: number, source: string) => Promise<ImportResult>;
};

type ImportResult = {
  status: ImportStatus;
  data?: any;
};

export function createImporter(canHandle: Importer['canHandle'], run: Importer['run']): Importer {
  return {
    canHandle,
    run,
  };
}
