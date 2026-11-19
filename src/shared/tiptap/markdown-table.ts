import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';

function alignment(value: unknown) {
  return value === 'left' || value === 'center' || value === 'right' ? value : null;
}

// Markdown pipe tables cannot represent merged cells or column widths.
function cellAttributes() {
  const singleCell = { default: 1, parseHTML: () => null, rendered: false };
  return {
    colspan: singleCell,
    rowspan: singleCell,
    colwidth: { default: null, parseHTML: () => null, rendered: false },
    align: {
      default: null,
      parseHTML: (element: HTMLElement) =>
        alignment(element.getAttribute('align') || element.style.textAlign),
      renderHTML: ({ align }: Record<string, unknown>) =>
        alignment(align) ? { style: `text-align: ${align}` } : {},
    },
  };
}

export const markdownTableExtensions = [
  Table.extend({
    renderHTML: () => ['div', { 'data-type': 'markdown-table' }, ['table', ['tbody', 0]]],
  }),
  TableRow,
  TableHeader.extend({
    addAttributes() {
      return {
        ...cellAttributes(),
        scope: {
          default: 'col',
          parseHTML: (element: HTMLElement) =>
            element.getAttribute('scope') === 'row' ? 'row' : 'col',
          renderHTML: ({ scope }) => ({ scope: scope === 'row' ? 'row' : 'col' }),
        },
      };
    },
  }),
  TableCell.extend({ addAttributes: cellAttributes }),
];
