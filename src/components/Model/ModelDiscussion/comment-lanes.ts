export type Lanes = { columnCount: number; byId: Map<number, number> };

/**
 * Places each id in a column once and keeps it there. TanStack's `lanes` option re-picks the
 * shortest lane for every item on every measurement pass, so cards swap columns as heights settle.
 */
export function assignLanes({
  ids,
  columnCount,
  previous,
  heights,
  estimate,
  gap,
}: {
  ids: number[];
  columnCount: number;
  previous?: Lanes;
  heights: ReadonlyMap<number, number>;
  estimate: number;
  gap: number;
}) {
  const lanes: Lanes =
    previous && previous.columnCount === columnCount ? previous : { columnCount, byId: new Map() };
  const columnHeights = Array<number>(columnCount).fill(0);
  const columns: number[][] = Array.from({ length: columnCount }, () => []);

  for (const id of new Set(ids)) {
    let lane = lanes.byId.get(id);
    if (lane === undefined) {
      lane = columnHeights.indexOf(Math.min(...columnHeights));
      lanes.byId.set(id, lane);
    }
    columnHeights[lane] += (heights.get(id) ?? estimate) + gap;
    columns[lane].push(id);
  }
  return { lanes, columns };
}
