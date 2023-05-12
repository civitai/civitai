export interface MasonryRenderItemProps<Item> {
  /**
   * The index of the cell in the `items` prop array.
   */
  index: number;
  /**
   * The rendered width of the cell's column.
   */
  width: number;
  height: number;
  /**
   * The data at `items[index]` of your `items` prop array.
   */
  data: Item;
}

export type MasonryImageDimensionsFn<TData> = (data: TData) => { height: number; width: number };
export type MasonryAdjustHeightFn<TData> = (
  args: {
    imageRatio: number;
    width: number;
    height: number;
  },
  data: TData
) => number;
