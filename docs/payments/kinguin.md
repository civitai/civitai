Okay, we need to create a basic page that links to the ability to purchase buzzed gift cards and buzzed memberships. Ideally, the individual buzzed gift cards will kind of have their own little blocks, and then the memberships will have a single block per membership type with an individual button for 3 month, 6 month, and 12 month. Here are all of the links.

https://www.kinguin.net/category/378758/civitai-com-3-month-bronze-membership-gift-card?referrer=civitai.com
https://www.kinguin.net/category/378757/civitai-com-50k-buzz-gift-card?referrer=civitai.com
https://www.kinguin.net/category/378783/civitai-com-6-month-silver-membership-gift-card?referrer=civitai.com
https://www.kinguin.net/category/378759/civitai-com-6-month-bronze-membership-gift-card?referrer=civitai.com
https://www.kinguin.net/category/378780/civitai-com-3-month-silver-membership-gift-card?referrer=civitai.com
https://www.kinguin.net/category/378785/civitai-com-12-month-silver-membership-gift-card?referrer=civitai.com
https://www.kinguin.net/category/378788/civitai-com-6-month-gold-membership-gift-card?referrer=civitai.com
https://www.kinguin.net/category/378789/civitai-com-12-month-gold-membership-gift-card?referrer=civitai.com
https://www.kinguin.net/category/378786/civitai-com-3-month-gold-membership-gift-card?referrer=civitai.com
https://www.kinguin.net/category/378762/civitai-com-12-month-bronze-membership-gift-card?referrer=civitai.com
https://www.kinguin.net/category/378756/civitai-com-25k-buzz-gift-card?referrer=civitai.com
https://www.kinguin.net/category/378753/civitai-com-10k-buzz-gift-card?referrer=civitai.com

Ideally we display the image of each card along with the product card `public\images\gift-cards`
Don't worry about displaying price at this time as that is something that is currently computed on Kinguin's side.

We'll also want to change all existing references to BuyBuzz.io to point to this new page. Ideally this page can handle filtering to specifically Memberships or Buzz cards as well to handle that case that we're replacing:
Summary of all buybuzz.io and gift card references:

Direct buybuzz.io links (8 occurrences across 5 files):

1. src/components/Subscriptions/PlanCard.tsx:195 - Link to memberships collection
2. src/components/Buzz/BuzzPurchaseImproved.tsx:365 - Main buybuzz.io link
3. src/components/Buzz/BuzzPurchaseImproved.tsx:893 - "Buy a gift card!" link
4. src/components/Buzz/BuzzPurchase.tsx:351 - Main buybuzz.io link
5. src/components/Buzz/BuzzPurchase.tsx:653 - "Buy a gift card!" link
6. src/pages/redeem-code.tsx:77 - Button linking to buybuzz.io
7. src/pages/pricing/index.tsx:195 - Link to memberships collection
8. src/pages/pricing/index.tsx:237 - "Buy a Gift Card" link

Gift card functionality references:

- Feature flag: liveFeatures.buzzGiftCards in src/server/common/constants.ts:1202,1206
- UI Components: Gift card promotional sections in BuzzPurchase.tsx and BuzzPurchaseImproved.tsx
- Redeem page: Gift card purchase options in src/pages/redeem-code.tsx:230
- Pricing page: Gift card purchase link in src/pages/pricing/index.tsx:234,242
- Styles: Gift card-related CSS classes in BuzzPurchaseImproved.module.scss

All links point to either the main buybuzz.io site or the memberships collection at buybuzz.io/collections/memberships. These will need to be replaced with whatever new URL structure you're planning to use.

Before beginning, to confirm your understanding, please prepare a summary of this project along with specific tasks below.

---

## Implementation Plan

### Overview
Create a new gift cards marketplace page at `/gift-cards` that displays Civitai Buzz gift cards and membership packages available through multiple vendors (starting with Kinguin), replacing the existing BuyBuzz.io integration.

### Page Structure

#### 1. Route & URL Structure
- **Main page**: `/gift-cards`
- **Filtered views**:
  - `/gift-cards?type=buzz` - Show only Buzz gift cards
  - `/gift-cards?type=memberships` - Show only membership packages
  - `/gift-cards?vendor=kinguin` - Show products from specific vendor
  - `/gift-cards?vendor=kinguin&type=buzz` - Combined vendor and type filtering

#### 2. Component Architecture
```
src/pages/gift-cards/index.tsx (Main page)
├── Components:
│   ├── VendorSelector (Dropdown/SegmentedControl for vendor selection)
│   ├── GiftCardGrid (Buzz cards display)
│   ├── MembershipSection (Membership tiers)
│   └── FilterTabs (Toggle between Buzz/Memberships)
├── Data:
│   └── vendors/
│       ├── kinguin.ts (Kinguin products and URLs)
│       └── types.ts (Vendor interface definitions)
```
@dev: Not sure if we need the filter tabs. I really just want there to be two sections on the page and that if the query param is set we only show that section...
@ai: Understood. I'll skip the filter tabs component and instead have both sections visible by default, with query parameters controlling which section(s) to show. The page will have:
- Buzz Gift Cards section (hidden when `?type=memberships`)
- Memberships section (hidden when `?type=buzz`)
- Both sections visible when no type filter is applied


#### 3. Data Structure

**Vendor Configuration:**
```typescript
interface Vendor {
  id: string;
  name: string;
  displayName: string;
  enabled: boolean;
  products: {
    buzzCards: BuzzCard[];
    memberships: Membership[];
  };
}

interface BuzzCard {
  amount: number;
  image: string;
  url: string;
  price?: number; // If not specified don't display
}

interface Membership {
  tier: 'Bronze' | 'Silver' | 'Gold';
  durations: {
    months: number;
    url: string;
    image: string;
    price?: number; // If not specified don't display
  }[];
}
```

**Kinguin Vendor Data:**

Buzz Gift Cards:
- 10K Buzz - Individual card block
- 25K Buzz - Individual card block
- 50K Buzz - Individual card block

Membership Tiers:
- Bronze Tier
  - 3 month button → https://www.kinguin.net/category/378758/civitai-com-3-month-bronze-membership-gift-card?referrer=civitai.com
  - 6 month button → https://www.kinguin.net/category/378759/civitai-com-6-month-bronze-membership-gift-card?referrer=civitai.com
  - 12 month button → https://www.kinguin.net/category/378762/civitai-com-12-month-bronze-membership-gift-card?referrer=civitai.com
- Silver Tier
  - 3 month button → https://www.kinguin.net/category/378780/civitai-com-3-month-silver-membership-gift-card?referrer=civitai.com
  - 6 month button → https://www.kinguin.net/category/378783/civitai-com-6-month-silver-membership-gift-card?referrer=civitai.com
  - 12 month button → https://www.kinguin.net/category/378785/civitai-com-12-month-silver-membership-gift-card?referrer=civitai.com
- Gold Tier
  - 3 month button → https://www.kinguin.net/category/378786/civitai-com-3-month-gold-membership-gift-card?referrer=civitai.com
  - 6 month button → https://www.kinguin.net/category/378788/civitai-com-6-month-gold-membership-gift-card?referrer=civitai.com
  - 12 month button → https://www.kinguin.net/category/378789/civitai-com-12-month-gold-membership-gift-card?referrer=civitai.com

#### 4. Visual Design

**Vendor Selection:**
- Positioned at the top of the page below the title
- Options:
  - SegmentedControl for 2-3 vendors (cleaner look)
  - Select/Dropdown for 4+ vendors (more scalable)
- Shows vendor display name with optional badge for "New" or "Sale"
- Defaults to first available vendor (Kinguin initially)

**Buzz Gift Cards Section:**
- Grid layout (3 columns on desktop, 2 on tablet, 1 on mobile)
- Each card displays:
  - Gift card image from `/public/images/gift-cards/`
  - Product Name
  - "Buy Now" button linking to selected vendor

**Membership Section:**
- 3 membership tier cards (Bronze, Silver, Gold)
- Each tier card contains:
  - Gift card image from `/public/images/gift-cards/`
  - Product Name
  - 3 duration buttons (3, 6, 12 months)
  - "Buy Now" button linking to selected vendor

#### 5. Implementation Tasks

1. **Create vendor data structure**
   - Define TypeScript interfaces for vendors
   - Create Kinguin vendor configuration file
   - Set up vendor registry/loader system

2. **Create page structure** (`/src/pages/gift-cards/index.tsx`)
   - Set up page layout with Meta component
   - Add Container and responsive grid
   - Implement URL query parameter handling for vendor AND type filtering
   - Add vendor selector component (SegmentedControl/Select)

3. **Build Buzz gift cards section**
   - Create card components that accept vendor data
   - Load and display images from `/public/images/gift-cards/`
   - Add external links with vendor-specific URLs and tracking parameters
   - Display vendor branding subtly

4. **Build Memberships section**
   - Create membership tier cards with vendor support
   - Add duration selection buttons per tier
   - Handle vendor-specific membership URLs

5. **Add filtering functionality**
   - Implement vendor selector (SegmentedControl or Select)
   - Implement type filter (Buzz vs Memberships)
   - Handle combined URL query parameters
   - Update displayed products based on selected vendor and type

6. **Update existing references**
   - Replace 8 BuyBuzz.io links across 5 files:
     - `src/components/Subscriptions/PlanCard.tsx:195`
     - `src/components/Buzz/BuzzPurchaseImproved.tsx:365, 893`
     - `src/components/Buzz/BuzzPurchase.tsx:351, 653`
     - `src/pages/redeem-code.tsx:77`
     - `src/pages/pricing/index.tsx:195, 237`
   - Update links to point to new `/gift-cards` page with appropriate filters

7. **Styling and responsiveness**
   - Create module.scss file for complex custom styles otherwise use default Mantine UI components or Tailwind
   - Style vendor selector appropriately
   - Ensure responsive design across devices
   - Match existing design patterns and theme

@dev: Probably worth noting that you should use Playwright MCP to confirm design and responsiveness.
@ai: Got it! I'll use the Playwright MCP tools to test the page design and responsiveness at different viewport sizes (mobile, tablet, desktop) to ensure the gift cards grid and membership sections display properly across all devices.

### Technical Considerations

- **No price display**: Prices are computed on vendor's side (Kinguin, etc.)
- **External links**: All purchase buttons open vendor site in new tab
- **Tracking**: Include appropriate referrer parameters for each vendor
- **Images**: Use existing gift card images in `/public/images/gift-cards/`
- **Consistency**: Match existing UI patterns
- **Vendor extensibility**: Structure code to easily add new vendors via configuration
- **Fallback**: If vendor has no products for a category, hide that section
- **State management**: Sync vendor selection with URL for shareable links

### Success Criteria

1. ✅ Vendor selector works and updates displayed products
2. ✅ All gift cards and memberships are displayed with proper images
3. ✅ Filtering works for both vendor selection and product type (Buzz/Memberships)
4. ✅ All BuyBuzz.io references updated to new page
5. ✅ Responsive design works on mobile, tablet, and desktop
6. ✅ All vendor links include appropriate tracking parameters
7. ✅ Page loads quickly and images are optimized
8. ✅ Easy to add new vendors by adding configuration files

@dev: I think to demo how the vendor extensibility works, let's also create a vendor for BuyBuzz.io but have it in a disabled state.
Buy Buzz Products:
https://buybuzz.io/products/buzz-gift-card?variant=46060036718741 (10k)
https://buybuzz.io/products/25k-buzz-gift-card?variant=46060341067925 (25k)
https://buybuzz.io/products/50k-buzz-gift-card?variant=46060341723285 (50k)
https://buybuzz.io/products/bronze-membership-gift-card?variant=46208038142101 (3mo)
https://buybuzz.io/products/bronze-membership-gift-card?variant=46208038174869 (6mo)
https://buybuzz.io/products/bronze-membership-gift-card?variant=46208038207637 (12mo)
https://buybuzz.io/products/silver-membership-gift-card?variant=46208048627861 (3mo)
https://buybuzz.io/products/silver-membership-gift-card?variant=46208048660629 (6mo)
https://buybuzz.io/products/silver-membership-gift-card?variant=46208048693397 (12mo)
https://buybuzz.io/products/gold-membership-gift-card?variant=46208048005269 (3mo)
https://buybuzz.io/products/gold-membership-gift-card?variant=46208048038037 (6mo)
https://buybuzz.io/products/gold-membership-gift-card?variant=46208048070805 (12mo)
@ai: Perfect! I'll create a BuyBuzz.io vendor configuration with `enabled: false` to demonstrate the extensibility. This will show how easy it is to add new vendors - they just need to add a new configuration file with the vendor's product URLs and set enabled to true when ready to go live. The vendor selector will only show enabled vendors.
