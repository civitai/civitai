<!--
PLACEMENT & INTEGRATION NOTES (for Justin, not part of the published terms)

Recommended final location:
  src/static-content/referrals/terms.md
  → served at /content/referrals/terms via src/pages/content/[[...slug]].tsx

This sits alongside the other program-specific terms already live on the site:
  - /content/tos                   (main TOS)
  - /content/buzz/terms            (Buzz Terms & Conditions)
  - /content/creator-program-v2-tos
  - /content/privacy

Cross-linking recommendations:
  1. Main TOS: add a single-line reference in the "Additional Terms" paragraph
     (Section 19.4) or alongside the Buzz reference in Section 4:
     "Your participation in the Civitai Referral Program is subject to the
     Referral Program Terms, which are incorporated into these Terms by this
     reference."

  2. /user/referrals dashboard: link in footer or next to the "Your code" hero
     section. YES - definitely link here. Small "Program Terms" text link is
     enough; users who care will click.

  3. Checkout flow: when a referral code cookie is present on the checkout page,
     show a small disclosure line under the code banner:
       "Using code XYZ. Referral Program Terms apply."
     with "Referral Program Terms" as a link. This covers disclosure for the
     referee side of the transaction without being in the way.

  4. Onboarding: no new link needed. Existing TOS acceptance covers it via the
     incorporation-by-reference line in main TOS.

Tone notes from reading existing Civitai legal docs:
  - Main TOS is conventional, numbered, capitalized-warnings legalese
  - Buzz Terms are much lighter, bolded-inline-definitions style, less formal
  - Creator Program v2 ToS is the closest match in spirit: short numbered
    sections, plain-English, practical rules + consequences
  - Draft below follows the Creator Program v2 / Buzz Terms tone (lighter,
    practical) rather than the main TOS tone (heavy legalese), which is
    consistent with how program-specific terms are written on this platform.
-->

---
title: Civitai Referral Program Terms
description: Terms of Service for the Civitai Referral Program
---

**Effective Date**: [CONFIRM: launch date]

These Referral Program Terms ("Referral Terms") govern your participation in the Civitai Referral Program ("Program") and are Additional Terms under the [Civitai Terms of Service](/content/tos) ("Terms of Service"), which is a legally binding contract between you and Civit AI, Inc. ("Civitai," "we," "us") and incorporated into these Referral Terms by this reference. Your use of Buzz earned through the Program is also subject to the [Buzz Terms and Conditions](/content/buzz/terms). Capitalized terms used but not defined here have the meanings set forth in the Terms of Service.

By sharing a referral code, redeeming someone else's referral code, or otherwise participating in the Program, you agree to these Referral Terms.

---

## 1. What the Program Is

The Civitai Referral Program lets you share a unique code with friends. When someone signs up using your code and later pays for a Civitai Membership or purchases Buzz, you earn rewards on the platform. The person who used your code ("Referee") also receives a small bonus on their first paid Membership.

The Program is designed to reward genuine word-of-mouth advocacy. It is not a cash program, not an investment vehicle, and not a multi-level marketing structure.

---

## 2. Definitions

For the purposes of these Referral Terms:

- **Referrer** - a Civitai user who shares a referral code.
- **Referee** - a Civitai user who signs up using a referral code and is attributed to a Referrer.
- **Referral Code** - the unique code automatically assigned to each eligible Civitai account. Civitai may also issue custom codes to select users (for example, social-media partners) at its sole discretion.
- **Referral Cookie** - the browser cookie set when someone visits Civitai via a referral link. The Referral Cookie lasts 30 days from the click.
- **Referral Token** - an on-platform credit earned by Referrers on qualifying Referee Membership payments. Redeemable in the Referral Shop for temporary Membership perks. Not redeemable for cash or Buzz.
- **Blue Buzz** - a non-transferable form of Buzz on the Service. Used primarily for NSFW generation and other platform features. Not redeemable for cash. See the [Buzz Terms](/content/buzz/terms).
- **Settlement** - the 7-day holding window after a qualifying event. During Settlement, rewards are "pending" and may be reversed if the underlying payment is refunded or charged back. After Settlement, rewards move to "settled" and become spendable.
- **Qualifying Event** - a paid Membership month or a Buzz purchase made by a Referee that triggers Referrer rewards under Section 4.

---

## 3. Eligibility

To participate in the Program, you must:

1. Have a Civitai account in good standing (not suspended, banned, or under active moderation action).
2. Have held your Civitai account for at least **7 days** before earning any rewards. Rewards triggered on accounts younger than 7 days will not accrue.
3. Meet all eligibility requirements under the Terms of Service, including the minimum-age requirement.

Civitai reserves the right to determine eligibility at its sole discretion and may deny, suspend, or revoke Program access at any time.

---

## 4. How You Participate

### 4.1 Your Referral Code

Each eligible Civitai account is automatically assigned **one** Referral Code. In limited cases, Civitai may issue a custom Referral Code to a specific user (for example, a creator with a public platform). Custom codes are granted at Civitai's sole discretion.

### 4.2 Attribution

When someone visits Civitai through a referral link, we set a Referral Cookie that lasts **30 days**. If that person creates a Civitai account while the cookie is active, they are attributed to you as a Referee. Attribution is one-time and permanent for that Referee: the Referee cannot later switch Referrers, and later clicks on different referral links do not re-attribute them.

### 4.3 Earning Referral Tokens

You earn Referral Tokens when your Referee pays for a Civitai Membership:

| Referee Membership Tier | Tokens per Paid Month |
|---|---|
| Bronze | 1 |
| Silver | 2 |
| Gold | 3 |

Tokens accrue for up to **the first 3 paid Membership months** per Referee. After that cap, additional Membership payments from the same Referee do not generate further Tokens.

### 4.4 Earning Blue Buzz

You earn **10% of each Referee's Buzz purchase amount** as Blue Buzz, credited to your Blue Buzz balance. Blue Buzz kickbacks apply only to yellow Buzz purchases made by your Referees; they do not apply to Membership payments, tips, creator earnings, or other non-purchase Buzz movements.

### 4.5 Referee Bonus

When a Referee makes their first paid Membership charge, they receive a one-time grant of **Blue Buzz equal to 25% of the Membership tier's monthly Buzz allotment**. For example, a Bronze Membership that grants 10,000 Buzz per month yields a 2,500 Blue Buzz bonus; higher tiers scale proportionally. The bonus is granted once per Referee, on the first qualifying payment.

### 4.6 Using Your Rewards

- **Referral Tokens** can be spent in the Referral Shop for temporary Membership perks (e.g., two weeks or one month at a selected tier). Perks granted through Token redemption do **not** include a monthly Buzz stipend and do **not** include tier-specific badges.
- **Blue Buzz** is spendable anywhere on Civitai where Blue Buzz is accepted, subject to the [Buzz Terms](/content/buzz/terms).

---

## 5. Settlement and Clawback

### 5.1 Settlement Window

Rewards earned from a Qualifying Event are held in a **pending** state for **7 days**. After 7 days pass without the underlying payment being reversed, the reward moves to **settled** and becomes spendable.

### 5.2 Chargebacks and Refunds Within the Settlement Window

If the Referee's underlying payment is refunded, disputed, or charged back **within 7 days**, the associated reward is **revoked cleanly** - the reward is removed from your pending balance before it settles, and no further action is taken against you.

### 5.3 Chargebacks and Refunds After the Settlement Window

If a payment is charged back **after the 7-day Settlement window**, Civitai absorbs the loss. You do not owe Civitai any rewards already settled, and your balance will not go negative as a result of a post-settlement chargeback. Civitai reserves the right to flag accounts with repeated post-settlement chargeback activity for manual review under Section 7.

### 5.4 Civitai's Right to Revoke for Abuse

Separate from payment-driven clawbacks, Civitai may revoke any pending, settled, or redeemed rewards at its sole discretion where we determine, in good faith, that the rewards were obtained in violation of these Referral Terms, the Terms of Service, or the Buzz Terms. See Section 7.

---

## 6. Token Expiry

Referral Tokens expire **90 days after they are earned**. Expired Tokens are forfeit and cannot be restored. We will make reasonable efforts to surface expiring Tokens in your Referral dashboard, but it is your responsibility to redeem Tokens before expiry.

Blue Buzz earned through the Program does not have a Program-specific expiry, but is subject to the general Buzz inactivity and termination rules in the [Buzz Terms](/content/buzz/terms).

---

## 7. Prohibited Behavior

The Program is meant to reward genuine advocacy. The following are **prohibited** and will result in revocation of rewards, removal from the Program, and may result in broader account action under the Terms of Service:

- **Bot-driven or automated referrals.** Using scripts, bots, headless browsers, click-farms, or any automation to generate clicks, sign-ups, or purchases under a Referral Code.
- **Mass self-referral.** Multiple accounts operated by one person or a coordinated group whose primary purpose is to refer one another to accrue rewards. Note: we understand that multiple members of a single household may each hold their own Civitai account and may legitimately refer one another. That is fine. What is not fine is creating or controlling accounts for the purpose of generating Program rewards.
- **Undisclosed incentivized clicks.** Purchasing clicks or sign-ups through paid advertising, incentivized-traffic networks, or rewarded-ad placements without clearly disclosing the referral relationship to the user being directed. Standard personal social-media sharing, creator-audience recommendations, and word-of-mouth are fine.
- **Coordinated rings.** Two or more users coordinating sign-ups, payments, or chargebacks to generate or manipulate Program rewards.
- **Use by banned or suspended accounts.** Codes owned by suspended, banned, or terminated accounts are invalid from the moment of account action.
- **Misrepresentation.** Pretending to be affiliated with Civitai, implying Civitai endorsement, or misrepresenting the terms of the Program to prospective Referees.
- **Misleading placement.** Placing referral links in contexts that mislead users about where the link goes, what they are agreeing to, or what they are about to pay for.
- **Any attempt to circumvent these Referral Terms** or otherwise exploit the Program.

Civitai reviews suspicious activity at its sole discretion. Enforcement actions may include revocation of pending or settled rewards, revocation of already-redeemed Membership time, removal from the Program, and account-level action under the Terms of Service up to and including account termination.

---

## 8. Non-Transferability; No Cash Value

Referral Tokens and Blue Buzz earned through the Program are:

- **Non-transferable.** You may not sell, trade, gift, or otherwise transfer Tokens or Program-earned Blue Buzz to any other user, inside or outside of Civitai.
- **Of no cash value.** Tokens and Blue Buzz cannot be redeemed for fiat currency, cryptocurrency, gift cards, or anything else outside of the in-platform uses described in these Referral Terms and the Buzz Terms.
- **Not property.** Your rights in Tokens and Program-earned Blue Buzz are a limited, revocable license to use them on the Service, not ownership or a property interest.

Any attempt to sell, trade, or transfer Tokens or Program-earned Blue Buzz outside the Service is a violation of these Referral Terms and the Terms of Service.

---

## 9. Taxes

You are solely responsible for determining whether any rewards you receive through the Program create tax obligations in your jurisdiction and for reporting and paying any such taxes. Civitai does not provide tax advice. Because Tokens and Blue Buzz are in-platform, non-cash, non-transferable, and of no cash value, Civitai generally does not treat them as income for tax-reporting purposes, but your local tax treatment is your responsibility.

---

## 10. Modification or Termination of the Program

Civitai reserves the right to modify these Referral Terms or to modify, suspend, or terminate the Program at any time, at its sole discretion. For material changes, we will provide **30 days' notice** via the Service (for example, by posting an update on the Referral dashboard or sending in-app notification).

If the Program is terminated:

- Already-settled Blue Buzz stays in your account, subject to the Buzz Terms.
- Already-settled Referral Tokens remain spendable in the Referral Shop for the duration of the notice period. After the notice period ends, unredeemed Tokens may be expired without compensation.
- Already-redeemed Membership time from previous Token redemptions continues to run through the end of its granted period.

Civitai may, in its sole discretion, also adjust the Token earn rates, the Blue Buzz kickback rate, the Settlement window, the Token expiry period, the Referee bonus, the cap on Referee paid months, or the Referral Cookie duration at any time, with reasonable notice for material changes.

---

## 11. No Guarantee

Participation in the Program does not guarantee any particular level of earnings, Token redemption availability, or continued availability of any specific reward. The Program is offered as-is and on an as-available basis. To the fullest extent permitted by law, Civitai disclaims all warranties related to the Program, and nothing in these Referral Terms creates a vested right to any specific reward.

---

## 12. Governing Law

These Referral Terms are governed by the laws of the State of Delaware, without regard to conflict-of-law principles, consistent with the governing-law clause of the Terms of Service. Any disputes arising out of or relating to these Referral Terms are subject to the dispute-resolution and arbitration provisions of the Terms of Service.

[CONFIRM: Keep Delaware to match main TOS Section 19.2, or prefer a different forum for Program-specific disputes?]

---

## 13. Relationship to Other Terms

These Referral Terms supplement, and do not replace, the [Terms of Service](/content/tos), the [Buzz Terms and Conditions](/content/buzz/terms), and any other Additional Terms applicable to your use of the Service. In the event of a conflict between these Referral Terms and the Terms of Service on a matter specific to the Program, these Referral Terms control for that matter only.

---

## 14. Contact

Questions about the Program or these Referral Terms can be sent to [support@civitai.com](mailto:support@civitai.com).

Civit AI, Inc.
447 Sutter St
Ste 405 PMB1283
San Francisco, CA 94108
