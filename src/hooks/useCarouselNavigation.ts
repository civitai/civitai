import { useState } from 'react';

export function useCarouselNavigation<T>({
  items,
  initialIndex = 0,
  maxIndicators = 20,
  onNext,
  onPrevious,
  onChange,
}: {
  items: T[];
  initialIndex?: number;
  maxIndicators?: number;
  onNext?: (item: T, index: number) => void;
  onPrevious?: (item: T, index: number) => void;
  onChange?: (item: T, index: number) => void;
}) {
  const [index, setIndex] = useState(initialIndex);

  const canNavigate = items.length > 1;
  const indicators = canNavigate && items.length <= maxIndicators ? items.length : 0;

  function navigate(index: number) {
    setIndex(index);
    onChange?.(items[index], index);
  }

  function next() {
    const newIndex = index < items.length - 1 ? index + 1 : 0;
    onNext?.(items[newIndex], newIndex);
    navigate(newIndex);
  }

  function previous() {
    const newIndex = index > 0 ? index - 1 : items.length - 1;
    onPrevious?.(items[newIndex], newIndex);
    navigate(newIndex);
  }

  return {
    indicators,
    canNavigate,
    index,
    navigate,
    next,
    previous,
  };
}
