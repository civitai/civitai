import { GOLD_ACCENT_GRADIENT } from '~/components/CreatorShop/Storefront/storefront.constants';

// Small gold accent bar shown to the left of each section title for a
// consistent heading treatment (a subtler echo of the Featured band).
export function SectionAccent() {
  return (
    <div style={{ width: 4, height: 22, borderRadius: 999, background: GOLD_ACCENT_GRADIENT }} />
  );
}
