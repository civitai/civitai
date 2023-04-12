type UseMasonryColumnsProps<TData> = {
  columnWidth: number;
  maxColumns?: number;
  containerWidth?: number;
  data: TData;
  widthFrom: (data: TData) => number;
  heightFrom: (data: TData) => number;
};

export function useMasonryColumns<TData>({
  columnWidth,
  maxColumns,
  containerWidth,
  data,
}: UseMasonryColumnsProps<TData>) {
  if (!containerWidth) return undefined;
  return [[], []];
}
