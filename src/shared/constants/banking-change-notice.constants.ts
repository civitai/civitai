export const BANKING_CHANGE_NOTICE_SUBJECT = 'Banking changes on November 1';

// Approved copy: change it only with sign-off. `{username}` is filled per reader; root-relative
// links and image paths are made absolute for email.
export const BANKING_CHANGE_NOTICE_MARKDOWN = `Hi {username},

**We're changing what can be banked so that the Buzz you bank from your own work earns more.**

## TL;DR

- **You keep earning generation compensation.** Every time someone generates with your models you still earn it, member or not, and you can spend it anywhere on Civitai.
- **From November 1, new generation compensation isn't bankable.** It no longer counts toward what you can bank in the Creator Program.
- **Licensing fees remain bankable.** Set a licensing fee on your models and what you earn from generations stays bankable. You choose the price.
- **Everything you hold on November 1 stays bankable.**

## How you earn from generations today

When someone generates with your models, you can earn in two ways:

- **Generation compensation:** Civitai creates Buzz equal to 25% of what the person paid, and splits it between the creators of the models they used. Nobody pays for that Buzz: Civitai creates it.
- **A licensing fee:** a price per generation that you set, paid by the person generating. (It's a fee you charge, not one you pay.)

From November 1, only licensing fees count toward what you can bank.

## Why

Say someone spends 1,000 Buzz generating images with your models. Civitai then creates another 250 Buzz, equal to 25% of what they paid, for the creators of the models used. That's generation compensation, and nobody paid for those 250 Buzz.

Each month, the Creator Program pool is split between everyone who banks, based on their share of all the Buzz banked that month. If you bank 10% of the Buzz, you get 10% of the pool. When created Buzz is banked alongside Buzz people paid for, there's more Buzz splitting the same pool, so the Buzz you bank from your work earns less.

A licensing fee is paid by the person generating, on top of the generation. Basing banking on what people pay for your work keeps the pool going to the creators whose work drives it.

## What's bankable

| Buzz | Bankable? |
|---|---|
| Everything you hold on November 1 | Yes |
| New licensing fees, paid access and early access | Yes |
| New tips from other users, donations, shop sales, bounties, App author fees, sticker and remix fees | Yes |
| New generation compensation | No, but you can still spend it on the site |
| Buzz you buy or get with a membership after November 1 | No |

Banking is how you take part in the Creator Program pool: you bank Buzz each month and receive your share of the pool.

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

Everyone's November 1 balance stays bankable, so the change phases in. Over the following two to three months, as less created Buzz is banked, we expect the Buzz you bank from your work to earn more.

**New from November 1:** the bank card on your [Buzz dashboard](/user/buzz-dashboard) shows how much you can still bank that month.

Thanks,
Justin
`;

// The dashboard alert stops appearing after this; the cutover is November 1.
export const BANKING_CHANGE_NOTICE_SHOW_UNTIL = new Date('2026-12-01T00:00:00Z');
