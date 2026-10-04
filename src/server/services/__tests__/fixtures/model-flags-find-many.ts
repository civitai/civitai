type ModelFlags = { minor: boolean; sfwOnly: boolean };
type FindManyArgs = {
  where: { id: { in: number[] } };
  select: { model?: { select?: Record<string, boolean> } };
};

/**
 * A `modelVersion.findMany` fake for the required-model content-level check. It returns only the
 * model fields the query selects, so a flag dropped from the select reads as unset and the test
 * fails instead of being answered by the fake.
 */
export const modelFlagsFindMany =
  (flagsFor: (versionId: number) => ModelFlags | undefined) =>
  async ({ where, select }: FindManyArgs) => {
    const fields = select.model?.select;
    if (!fields) return [];
    return where.id.in.flatMap((id) => {
      const flags = flagsFor(id);
      if (!flags) return [];
      return [{ model: Object.fromEntries(Object.entries(flags).filter(([key]) => fields[key])) }];
    });
  };
