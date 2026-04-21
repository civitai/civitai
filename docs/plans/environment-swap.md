# Environment Swap: Green → Com, Com → Red

## Domain Mapping Context

`feature-flags.service.ts` defines domains for `green`, `blue`, and `red`.

- **Current state:** `green` serves civitai.green, `blue` serves civitai.com.
- **After this migration:** `green` serves civitai.com, `blue` serves civitai.red, and `red` also serves civitai.red.
- **Future cleanup:** Once the migration is complete, the `green`/`blue` variable names will be renamed to something more appropriate.
- **Content split:** civitai.com will have **no NSFW content** (SFW-only). civitai.red will have **only NSFW content**. Use this when reasoning about gating, fallbacks, and per-domain feature behavior.

### Epic 1: New Feature Work
**Variable Rename** [@Justin Maier](#user_mention#10620972)

**10\. SFW article filtering** ~4-8hr [@Manuel Emilio](#user_mention#16807894)
Verify article images are NSFW-scanned. If not, implement scanning so articles on .com only show SFW content. **May block launch.**
- [x] Add article image scanning
- [x]     Add article content scanning
    - [x] Hook up text scanning to use XGuard [@Manuel Emilio](#user_mention#16807894) (Talk with Briant about how to use XGuard)
    - [ ] Add PG-XXX ratings to Text Scan category [@Sebastian Widlund](#user_mention#63130867)
- [x]     Scan all articles to apply content and image ratings
    - [x] Images
    - [x] Content
- [x] Article rating needs to be max of (image nsfw level, article nsfw level from user, article content detected level)

**11\. NSFW auction placeholder slots** ~2-4hr [@Luis Eduardo Rojas Cabrera](#user_mention#75313214)
Show redacted/placeholder cards for NSFW auction items on .com. All other NSFW content is fully hidden.

**12\. Unified auctions: accept any paid buzz color** ~2-4hr [@Luis Eduardo Rojas Cabrera](#user_mention#75313214)
Allow green, yellow, and (future) red buzz in auction bids. Currently auctions are gated off green entirely. // @luis: Not tested, but technically the logic is in there already. I added support for this a while back when we did the green migration. Just needs proper testing.

**13\. Direct ads only on .red** ~2-4hr [@Briant Diehl](#user_mention#10602591)
Implement ad filtering so .red only shows direct-sold ads (no programmatic). .com gets full ads.

- civitai.red uses `CivitaiAdUnit` (direct-sold only)
- civitai.com uses Snigel ads (programmatic)

**14\. Mature content migration banner** ~4-6hr [@Justin Maier](#user_mention#10620972)
Persistent, dismissable announcement targeting users who had mature content enabled. Detect from user settings, direct them to [civitai.red](http://civitai.red). Don't show to new users or those who never enabled NSFW.

**15\. Creator program: enable on .com + unify comp pool** ~2-4hr [@Luis Eduardo Rojas Cabrera](#user_mention#75313214)
Remove "Coming Soon" placeholder, enable full creator program on .com. Merge to single compensation pool (all paid buzz eligible, rewards buzz excluded).

* * *

### Epic 2: UI & Branding Updates

**16\. Update UI theming for domain swap** ~2-3hr
Swap favicon, header border color, HTML class, footer 2257 link visibility, `useDomainColor` hook behavior for the new .com = green mapping.

**17\. Update TOS serving** ~30min [@Justin Maier](#user_mention#10620972)
Serve `tos.green.md` on .com via `content.service.ts`.

**18\. Swap GA tracking IDs** ~30min [@Briant Diehl](#user_mention#10602591)
Update `GoogleAnalytics.tsx` for new domain mapping.

**~~19\. Swap chatbot UUID~~** ~~~30min~~
Update `AssistantChat.tsx` GPTT UUID for new .com.
* * *

### ~~Epic 3: Payments & Buzz~~
[@Justin Maier](#user_mention#10620972)_: Should just work with variable rename and domain adjustment_

**20\. Update payment provider logic** ~1hr
Adjust forced-Stripe logic in `usePaymentProvider.ts` for new domain mapping. // @luis: Should be resolved by just keeping `isGreen` as a variable.

**21\. Update buzz purchase redirects** ~1-2hr
Fix cross-domain buzz purchase flows in `BuzzPurchaseImproved.tsx` and `pricing/index.tsx`.

**22\. Update membership plans display** ~1hr
Fix annual membership visibility and plan details in `MembershipPlans.tsx` and `getPlanDetails.tsx`.
* * *
### ~~Epic 4: Feature Flags & Domain Gating~~
 [@Justin Maier](#user_mention#10620972)_: Should just work with variable rename and domain adjustment_

**6\. Remap feature flags for domain swap** ~3-4hr
Update ~15 flags in `feature-flags.service.ts`. Re-enable on .com (green): articles, chat, challenges, auctions, payments. Keep bounties red-only. Update `canViewNsfw`, `adsEnabled`, `isGreen`/`isBlue`/`isRed` logic.

**7\. Update mature content gating** ~2hr
Swap `allowMatureContent` check in `AppProvider.tsx`, `uploadImage.ts`, and orchestrator endpoints to use new domain mapping. // @luis - If we keep isGreen,it'd be driven by the `FEATURE_FLAG_IS_GREEN` and `NEXT_PUBLIC_SERVER_DOMAIN_GREEN` I believe.

**8\. Update region-restricted redirect** ~30min
Point `region-restriction.middleware.ts` to .com instead of .green.

**9\. Update prompt auditing error messages** ~30min
### Change "go to [civitai.com](http://civitai.com)" to "go to [civitai.red](http://civitai.red)" in `promptAuditing.ts`. // @luis: Auto-solved by keeping `isGreen`

* * *

### Epic 5: Infrastructure & Deployment
[@Zachary Lowden](#user_mention#81593871) need to get [stage.civitai.com](http://stage.civitai.com) => Green and [stage.civitai.red](http://stage.civitai.red) => Blue

**1\. Swap domain env vars in prod.env** ~1hr
Change `NEXT_PUBLIC_SERVER_DOMAIN_GREEN/BLUE/RED` mappings in civitai-deployment repo.

**2\. Update ingress: canary + sticky sessions on both domains** ~2hr
Move DataPacket canary routing and cookie affinity from civitai.com-only to both .com and .red ingresses. Update `civitai-prod-deployment.yml` and `civitai-safe-ingress.yml`.

**3\. Add green/buzz domain 301 redirects** ~1hr
Configure `civitai.green` and `civitai.buzz` to 301 redirect to `civitai.com` in ingress config.

**4\. Add** [**civitai.red**](http://civitai.red) **OAuth redirect URIs** ~1-2hr
Register `civitai.red` with Google, Discord, GitHub OAuth providers (same pattern as existing green setup).

**5\. Verify Cloudflare DNS/TLS/WAF** ~1hr
Confirm TLS certs, DNS records, and any domain-specific page rules or WAF rules are correct for the new mapping.
* * *
### Epic 6: Testing & Rollout

**23\. Staging test with modified host headers** ~4-8hr
Full test pass: auth flows, buzz transactions, payments, generation, ads, article filtering, auctions on staging.

**24\. Deploy during low-traffic window** ~2hr
Coordinated deploy of both model-share and civitai-deployment changes.

**25\. User communication** ~2-4hr
Discord announcement, in-app banner, email blast about the domain swap.

* * *
Luis: General comment, I suggest we just rename `isGreen` to `isSafeSite` on the codebase. Should auto-solve most issues.