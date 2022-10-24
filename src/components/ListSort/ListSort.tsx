import { ModelSort } from '~/server/common/enums';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { useModelStore } from '~/hooks/useModelStore';

const sortOptions = Object.values(ModelSort);

// export function ListSort() {
//   const router = useRouter();
//   const sort = ([] as string[]).concat(router.query.sort ?? '').join('') as ModelSort;
//   const setSort = (value?: ModelSort) =>
//     router.replace({
//       query: { ...router.query, sort: value },
//     });

//   return (
//     <SelectMenu
//       label={sort}
//       options={sortOptions.map((x) => ({ label: x, value: x }))}
//       onClick={setSort}
//       value={sort}
//     />
//   );
// }

export function ListSort() {
  const sort = useModelStore((state) => state.filters.sort);
  const setSort = useModelStore((state) => state.setSort);

  return (
    <SelectMenu
      label={sort}
      options={sortOptions.map((x) => ({ label: x, value: x }))}
      onClick={setSort}
      value={sort}
    />
  );
}
