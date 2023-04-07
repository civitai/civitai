export const createDebouncer = (timeout: number) => {
  let timer: NodeJS.Timeout | undefined;
  const debouncer = (func: () => void) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      func();
    }, timeout);
  };
  return debouncer;
};
