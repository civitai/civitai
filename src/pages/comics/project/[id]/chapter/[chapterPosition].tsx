// Path-based chapter route. Mounts the same workspace as
// `/comics/project/[id]/index.tsx`; the workspace component reads
// `router.query.chapterPosition` (set by this dynamic segment) to pick
// which chapter to show. Sharing the page module keeps the logic in one
// place — only the URL surface differs between the two routes.
export { default, getServerSideProps } from '../index';
