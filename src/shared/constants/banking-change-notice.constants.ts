export const BANKING_CHANGE_NOTICE_SUBJECT = 'Banking changes on November 1';

// Approved copy: change it only with sign-off. `{username}` is filled per reader; root-relative
// links and image paths are made absolute for email.
export const BANKING_CHANGE_NOTICE_MARKDOWN = `Hi {username},

## TL;DR

- **You keep earning generation compensation.** Every time someone generates with your models you still earn it, member or not, and you can spend it anywhere on Civitai.
- **From November 1, new generation compensation isn't bankable.** It no longer counts toward what you can bank in the Creator Program.
- **Licensing fees remain bankable.** Set a licensing fee on your models and what you earn from generations stays bankable. You choose the price.
- **Everything you hold on November 1 stays bankable.**

## How you earn from generations today

There are two ways to earn when someone generates with your models:

- **Generation compensation** is automatic: Civitai adds a share for the creators whose models were used. You don't set anything up.
- **A licensing fee** is a price per generation that you set, and the person generating pays it. (It's a fee you charge, not one you pay.)

From November 1, only licensing fees count toward what you can bank.

## Why

Say someone spends 1,000 Buzz generating images with your models. That 1,000 Buzz pays for the generation itself. Civitai then adds another 250 Buzz for the creators of the models used. That's generation compensation: 25% on top, and nobody paid for those 250 Buzz. It works like inflation: more Buzz, with no more money behind it, so every Buzz is worth a little less.

That worked while Buzz stayed on the site. But banking pays you a share of a fixed pool of money. If you bank 10% of all the Buzz banked in a month, you get 10% of the pool. Every Buzz banked with no money behind it shrinks everyone's share, so each Buzz pays out less. And when each Buzz pays out less, creators have to charge more Buzz for paid access, so buyers get less for their money.

A licensing fee is paid by the person generating, on top of the generation. The Buzz you earn from it has real money behind it.

## What's bankable

| Buzz | Bankable? |
|---|---|
| Everything you hold on November 1 | Yes |
| New licensing fees, paid access and early access | Yes |
| New tips from other users, donations, shop sales, bounties, App author fees, sticker and remix fees | Yes |
| New generation compensation | No, but you can still spend it on the site |
| Buzz you buy or get with a membership after November 1 | No |

Banking is how you get paid out: you put Buzz into the Creator Program pool each month and receive your share of the money in it.

## Example

You hold 200,000 Buzz on November 1. During November you earn 50,000 from licensing fees and sales, and 80,000 from generation compensation. You can bank up to 250,000. The 80,000 can still be spent on the site, but it isn't bankable.

![What you can bank at the end of November](/images/email/banking-change-notice/november-example.jpg)

## Your monthly limit

![You can bank the lower of two numbers](/images/email/banking-change-notice/monthly-limit.jpg)

Each month you can bank the lower of two numbers: your bankable Buzz and your tier cap. Your tier cap works the same as today, with one change: generation compensation no longer counts toward your best month. If most of your earnings came from generation compensation, your cap may go down. The 100,000 minimum stays.

## Switch to licensing fees

If you want what you earn from generations to stay bankable, put licensing fees on the models you care about. You choose the price, and you can change or remove it at any time.

**To help you switch,** you can add licensing fees to up to 100 models through the end of October, on top of your usual monthly allowance.

## What to expect

Everyone's November 1 balance stays bankable, so the change phases in. We expect each banked Buzz to be worth more over the following two to three months. When each Buzz pays out more, you can charge fewer Buzz for the same money, and buyers get more for theirs.

**New from November 1:** the bank card on your [Buzz dashboard](/user/buzz-dashboard) shows how much you can still bank that month.

Thanks,
Justin
`;

// The dashboard alert stops appearing after this; the cutover is November 1.
export const BANKING_CHANGE_NOTICE_SHOW_UNTIL = new Date('2026-12-01T00:00:00Z');
