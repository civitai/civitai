# Stop It Now! / Lucy Faithfull Foundation Integration

## Overview

Civitai partners with the **Lucy Faithfull Foundation** to help redirect individuals who may be searching for child sexual abuse material (CSAM) toward professional support resources. When our system detects searches that may indicate someone is looking for this type of content, we display an intervention message with confidential help resources instead of search results.

## Where It Appears

The intervention appears in two places on the site:

1. **Search Results Page** — When a user submits a search from the main search page, a full-page intervention replaces the normal results
2. **Search Autocomplete** — When typing in the search bar, the dropdown will show "Blocked" instead of suggestions

## What Users See

When triggered, users see a warning message that includes:

- A clear statement that their search may be for illegal content
- Information that viewing, sharing, or creating such content is a serious crime
- **Confidential support resources:**
  - **Phone (UK):** Stop It Now! helpline — **0808 1000 900** (no caller ID saved)
  - **Online Support (Global):** Link to [stopitnow.org.uk](https://www.stopitnow.org.uk/self-help/concerned-about-your-own-thoughts-or-behaviour/) for self-help tools, live chat, and secure email
- Links to our Terms of Service and Safety Center
- A link to return to the homepage

## What Triggers It

The system automatically detects search queries that combine inappropriate terms with references to minors. This includes:

- Explicit age references (e.g., specific ages under 18)
- Common terms used to describe minors
- Various spelling variations and attempts to evade detection

The detection is designed to minimize false positives while catching genuine attempts to find harmful content.

## Tracking

When an intervention is triggered, we log the event (labeled `CSAM_Help_Triggered`) for internal analytics. This helps us understand how often the feature is used and ensures the system is working as intended.

## Related Resources

- [Safety Center](/safety)
- [Terms of Service - Content Policies](/content/tos#content-policies)
