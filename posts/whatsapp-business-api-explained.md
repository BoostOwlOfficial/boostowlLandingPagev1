If you've ever tried to send a bulk WhatsApp message from your phone, you know the experience: WhatsApp throws up a warning, threatens to ban your number, and your contacts get a tiny "via your business" tag if they get the message at all.

That's because you were trying to use the **personal** WhatsApp app for business. Meta has a separate product for that — the **WhatsApp Business Platform** (commonly called the WhatsApp Business API) — and it works very differently. This post explains what it is, why it matters, and what your obligations look like as a small business in India.

## Three flavours of WhatsApp

There are three products with "WhatsApp" in the name. They're easy to confuse.

| Product | Who it's for | Bulk messaging? |
|---|---|---|
| WhatsApp (personal) | Anyone with a phone | No |
| WhatsApp Business app | Solopreneurs / micro-businesses | No — limited broadcast only |
| WhatsApp Business Platform (API) | Businesses with more volume | Yes, with rules |

Most small businesses start on the **Business app** (the green one with the briefcase icon). It's free, it gives you a "Business Profile," and it has labels and quick replies. But it runs on a phone, doesn't sync to a real back-end, and broadcasts max out at 256 contacts.

The **Business Platform / API** is what you graduate to once you outgrow the app. It's not a separate app — it's a way for *software* to send and receive WhatsApp messages on your behalf, through Meta's servers, with no phone in the loop.

## How the API actually works

You don't talk to the API directly. You talk to it through a **Business Solution Provider** (BSP) — a Meta-approved company like BoostOwl, AiSensy, Wati, etc. The BSP handles:

- The technical integration with Meta.
- Your business verification.
- The display name approval.
- The phone number provisioning.
- Billing (Meta charges per-message; BSPs pass that through plus a markup).

Once you're set up, your business gets a WhatsApp number (you can port your existing number, with some caveats) and that number is now driven by software, not by someone tapping on a phone.

## Service messages vs. marketing messages

This is the part most people get wrong. Meta has two billing categories, and they're priced very differently.

### Service messages

These are conversations the **customer started**. If a customer messages you, you have a **24-hour service window** to reply freely — to that conversation, anything you want, no template required.

- Order confirmations
- Payment receipts
- Delivery updates
- Customer support replies
- "Yes, 9pm is available"

These are **unlimited** on most BSP plans (including BoostOwl's). You'll never pay extra for these.

### Marketing messages

These are messages **you** start outside the 24-hour window. Things like:

- "Hi, we're having a sale this weekend"
- "Reminder: your subscription expires next week"
- "We haven't seen you in a while, here's 10% off"

Marketing messages are:

1. **Template-only.** You have to submit the text in advance to Meta and get it approved.
2. **Opt-in required.** You need the customer's documented consent to message them.
3. **Charged per-message.** Indian rates are typically ₹0.80 - ₹0.90 per message.

If a business is sending you "marketing-looking" content as a service message, they're either breaking the rules or playing fast and loose with the 24-hour window. Meta is increasingly strict about this.

## What you need to use the API

To get a WhatsApp Business Platform account in India, you'll need:

1. **A registered business** — proprietorship, LLP, Pvt. Ltd., etc. Sole individuals can't do this directly.
2. **A Meta Business Manager account** (free, takes 10 minutes).
3. **Business verification** — Meta will ask for proof of business: incorporation certificate, GST, or similar.
4. **A phone number** you can dedicate to the platform. It cannot be used in the regular WhatsApp app at the same time.
5. **A display name** — what shows up to customers. Has to match your verified business name, broadly. Approval typically takes 1-3 days.

That sounds like a lot. In practice, with a BSP doing the paperwork, this takes about a week from start to finish.

## What it costs

Two costs you should know about:

1. **Per-message fees** (paid to Meta, passed through by your BSP).
   - Service messages: free.
   - Utility messages (order updates, etc.): ~₹0.12 per message in India.
   - Marketing messages: ~₹0.80 per message in India.
2. **BSP platform fee** — what your software provider charges. Ranges from ₹500/month for entry-level tools to ₹50,000+/month for enterprise platforms.

At BoostOwl, our pricing starts at ₹999/month. We don't mark up Meta's message fees — what they charge us, we charge you. The Meta fees are billed monthly based on actual usage.

## The TL;DR

If you're a small business in India and customers are messaging you on WhatsApp, the API is almost certainly worth the move — even at low volumes. The biggest unlocks aren't the bulk-messaging features. They're:

- Multiple staff handling the same number.
- Chatbots for the routine stuff.
- A proper customer record that survives staff changes.
- Sending GST invoices, payment links, and order updates without copy-pasting from another tool.

If you'd like to see what it looks like before you commit to anything, [message us on WhatsApp](index.html#wa) — we'll walk you through a live account in 20 minutes.

— Mayank
