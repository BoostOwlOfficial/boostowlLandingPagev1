A few months ago, a cricket ground in Hapur, Uttar Pradesh became our first paying customer. They run a turf called Apex Sports Ground. Two pitches, evening light, paying customers from 5pm to midnight, weekends booked solid.

Before BoostOwl, the booking process looked like this:

1. A customer messages on WhatsApp asking for a 9pm slot.
2. The owner opens a paper register, checks the page for that date, scans for 9pm.
3. He replies: "9pm is gone, 10pm available."
4. Customer says, "Theek hai, book karo."
5. Owner pencils in the name, says "advance bhej do."
6. Customer maybe sends advance. Maybe doesn't. Owner maybe follows up. Maybe forgets.

Multiply that by 30-40 inquiries a day, across two phones, two staff, no shared source of truth. Slots get double-booked. Advances get lost. The owner spent his evenings on his phone instead of running the ground.

## What changed

We didn't change the customer's experience at all. They still message the same WhatsApp number. They still see a reply within seconds. From their side, nothing is different.

What changed is the back-end. Now:

- The chatbot reads the inquiry, looks up the calendar, replies with the next 3 available slots.
- If the customer picks one, the bot generates a payment link for the advance.
- The moment the advance is received, the slot is locked. The bot confirms and sends a Google Maps pin.
- The owner sees the booking on the dashboard, in his shared inbox, on his phone — three places, one source of truth.
- The day before the booking, an automated reminder goes out. After the game, a thank-you message with a "rate us" link.

The owner stopped flipping pages in a register. His staff stopped fighting over which phone had the latest version.

## The numbers

In the first month:

- **76 unique contacts** captured (vs. zero before — these were just names in a register, not a database).
- **58 conversations** managed through the shared inbox.
- **6 bookings per day** average, up from 4. Not because demand grew — because they stopped losing customers to slow replies and missed messages.
- **0 double-bookings**. Down from "two or three a month."
- **₹14,000+ in extra revenue** captured in month one, from advances that previously slipped.

The owner isn't a software person. He's a sports guy who knows his ground and his customers. He didn't want a dashboard. He wanted his evenings back.

## What we learned

A few things we didn't expect:

**Onboarding is a meeting, not a wizard.** We tried doing self-serve onboarding. It didn't work. The owner doesn't think in terms of "create a chatbot flow." He thinks: "When someone asks about 9pm on Saturday, what should we say?" We had to sit with him for an afternoon, watch him handle real inquiries, and translate that into automation.

**The dashboard is for the owner. The inbox is for the staff.** Two different products for two different users. We over-indexed on the dashboard early on and the staff hated it. They wanted a chat list. So we built one.

**"GST invoice" is a bigger deal than we thought.** Half the bookings now come from corporates running cricket events. They need a proper Tax Invoice with HSN, CGST/SGST, the works. Without it they can't claim the expense. With it, they pay 50% more for the same slot.

**Trust beats features.** The owner doesn't read our changelog. He doesn't know we shipped a new automation engine last month. What he knows is that he WhatsApp'd Prateek at 11pm on a Saturday about a stuck payment, and Prateek replied. That's the feature.

## What's next

We're rolling the same pattern out to two more businesses this month — a clinic in Lucknow and a coaching centre in Meerut. Same engine, different plugin. Patients instead of slots. Batches instead of pitches.

If you run an SMB and any of this sounds familiar — the paper register, the missed advances, the phone-as-CRM — we'd love to talk. [WhatsApp us](index.html#wa) or email [prateek@boostowl.io](mailto:prateek@boostowl.io). We'll show you a working account, on a real business, in 20 minutes.

— Prateek
