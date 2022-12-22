import { createReport } from './../services/report.service';
import { throwDbError } from '~/server/utils/errorHandling';
import { Context } from '~/server/createContext';
import { ReportInput } from '~/server/schema/report.schema';

export async function createReportHandler({
  input,
  ctx,
}: {
  input: ReportInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    return await createReport({ ...input, userId: ctx.user.id });
  } catch (e) {
    console.log({ e });
    throw throwDbError(e);
  }
}
