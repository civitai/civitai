import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react';

export type NestedHeading = {
  id: string;
  title: string | null;
  level: number;
  items?: NestedHeading[];
};

export const useHeadingsData = () => {
  const [nestedHeadings, setNestedHeadings] = useState<NestedHeading[]>([]);

  useEffect(() => {
    if (nestedHeadings.length) return;

    const headingElements = Array.from(
      document.querySelectorAll('article h1, article h2, article h3')
    );

    const newNestedHeadings = getNestedHeadings(headingElements);
    setNestedHeadings(newNestedHeadings);
  }, [nestedHeadings.length]);

  return { nestedHeadings };
};

/**
 * @see https://www.emgoto.com/react-table-of-contents/#calculate-the-index-of-the-active-heading
 */
export const useIntersectionObserver = (setActiveId: Dispatch<SetStateAction<string>>) => {
  const headingElementsRef = useRef<Record<string, IntersectionObserverEntry>>({});
  useEffect(() => {
    const callback = (headings: IntersectionObserverEntry[]) => {
      headingElementsRef.current = headings.reduce((map, headingElement) => {
        map[headingElement.target.id] = headingElement;
        return map;
      }, headingElementsRef.current);

      const visibleHeadings: IntersectionObserverEntry[] = [];
      Object.keys(headingElementsRef.current).forEach((key) => {
        const headingElement = headingElementsRef.current[key];
        if (headingElement.isIntersecting) visibleHeadings.push(headingElement);
      });

      const getIndexFromId = (id: string) =>
        headingElements.findIndex((heading) => heading.id === id);

      if (visibleHeadings.length === 1) {
        setActiveId(visibleHeadings[0].target.id);
      } else if (visibleHeadings.length > 1) {
        const sortedVisibleHeadings = visibleHeadings.sort(
          (a, b) => getIndexFromId(a.target.id) - getIndexFromId(b.target.id)
        );
        setActiveId(sortedVisibleHeadings[0].target.id);
      }
    };

    const observer = new IntersectionObserver(callback, {
      rootMargin: '0px 0px -40% 0px',
      threshold: 1,
    });

    const headingElements = Array.from(
      document.querySelectorAll('article a[id], article h1, article h2, article h3')
    );

    for (const element of headingElements) {
      if (element.id) observer.observe(element);
    }

    return () => observer.disconnect();
  }, [setActiveId]);
};

/**
 * Thrown together with ChatGPT :) -Manuel
 */
const getNestedHeadings = (headingElements: Element[]) => {
  const nestedHeadings: NestedHeading[] = [];
  const headingLevels: { [level: string]: NestedHeading[] } = {};

  const addHeadingToLevel = (level: string, id: string, title: string | null) => {
    const parentLevel = Number(level) - 1;

    if (!headingLevels[parentLevel]) {
      headingLevels[parentLevel] = [];
    }

    const parentHeadings = headingLevels[parentLevel];
    const parentHeading = parentHeadings[parentHeadings.length - 1];

    const newHeading: NestedHeading = { id, title, level: Number(level), items: [] };

    if (parentHeading?.items) {
      parentHeading.items.push(newHeading);
    } else {
      nestedHeadings.push(newHeading);
    }

    if (!headingLevels[level]) {
      headingLevels[level] = [];
    }

    headingLevels[level].push(newHeading);
  };

  headingElements.forEach((heading) => {
    const { textContent: title, id } = heading;
    const level = heading.nodeName.charAt(1);

    addHeadingToLevel(level, id, title);
  });

  return nestedHeadings;
};
