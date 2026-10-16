// a looping carousel's first and last slides are neighbors
export function isAdjacent(i: number, index: number, length: number, loop: boolean) {
  if (length < 2) return i === index;
  const distance = Math.abs(i - index);
  return (loop ? Math.min(distance, length - distance) : distance) <= 1;
}
