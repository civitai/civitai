export {};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      ['pgs-ad']: React.HTMLAttributes<HTMLDivElement>;
    }
  }
}
