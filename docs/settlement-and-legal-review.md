# VYBE Tickets: settlement provider and legal review pack

**Purpose.** You chose (2026-10-26): VYBE charges **organisers a commission** (live as platform terms v2: 5 % of the ticket subtotal, no buyer fee), settlement will go through **a payment provider**, and the model will get a **legal review**. This document gives the provider and the lawyer what they need. It is a working brief, **not legal advice**. Statutes are named so the reviewer can check them; every "confirm" item is a question for them, not a conclusion.

## 1. How the money flows today (VERIFIED in code and tests)

1. A buyer pays the **ticket price only**. VYBE does not add a fee under v2, and the checkout shows the exact total before paying.
2. PayFast (card / instant EFT) or Ozow (EFT) collects the money into **VYBE's merchant account**. A ticket is issued only after the gateway's signed notification is verified, the amount matches, and (PayFast) the gateway confirms it server-to-server.
3. The journal records each sale:
   - the cash collected;
   - what VYBE owes the organiser (ticket subtotal minus 5 %, the *organiser payable*);
   - VYBE's commission revenue.
   PayFast's own fee (sent with each payment) is booked as **VYBE's processing cost**, never deducted from the organiser. Ozow does not report a fee per payment, so Ozow costs come from its statements.
4. Refunds return money to the buyer from VYBE's account and reverse the commission in proportion.
5. Organisers request payouts once:
   - the event has ended and the hold period has passed (default 3 days);
   - their bank account is verified;
   - the 72-hour cool-off after a bank-detail change has passed;
   - no risk hold is open.
   An admin approves the payout and a different admin confirms the bank transfer with its reference. Above R5,000 the approver and confirmer must be two different admins. If a transfer fails, the payout is marked failed, the amount becomes available again and the payee is told.

**Consequence:** between the ticket sale and the payout, **VYBE holds organisers' money in its own merchant/bank account.** This is the main legal question in section 3.

## 2. What we need from a settlement provider

These are requirements for whichever provider you choose. Confirm each one with the provider in writing.

| Need | Why | Status in VYBE |
| --- | --- | --- |
| Either **split settlement** at payment time (the organiser's share settles straight to the organiser's own account) or **payouts to verified third-party bank accounts** by API | Avoid VYBE holding organiser funds, or hold them in a structure the provider and SARB rules allow | Not integrated. BLOCKED on choosing a provider. |
| Beneficiary onboarding/KYC by the provider (organiser identity, bank-account verification) | Today an admin checks bank details by hand | Manual verification plus cool-off in place |
| Idempotency keys on payouts and a status query for every payout | So a timeout can be checked instead of paid twice | The payout state machine is ready for this (requested → approved → paid / failed) |
| Payout status webhooks, signed | So "paid" comes from the provider, not a person clicking | Today "paid" = second admin enters the bank reference |
| Refund API covering the original method (card **and** EFT) | Ozow EFT refunds are manual today | PayFast card refunds use the API; the rest are manual |
| Per-transaction fee reporting (or a statement API) | Accurate processing costs | PayFast fees captured automatically; Ozow fees not |
| Sandbox with test payouts | So we can prove it before going live | — |
| Chargeback / dispute notifications by API | Disputes are recorded by hand today | Manual |

**Candidates to ask** (capabilities **not verified here**, ask each one):
- **PayFast:** ask about split payments / marketplace settlement for third-party merchants.
- **Ozow:** ask about payouts / disbursements.
- Payment platforms in South Africa that advertise payouts or marketplace settlement (for example Stitch, Peach Payments, Paystack).

Choose based on their written answers to the table above and their fees.

**What I can build once a provider is chosen:**
- A payout adapter: prepare → provider call with idempotency key → webhook/status poll → paid / failed / reconciliation required.
- A beneficiary-sync step.
- Webhook verification.
- Sandbox end-to-end tests like the PayFast ones.

The database side (journal postings, payout states, dual control, holds) already exists and stays the same.

## 3. Legal review checklist (for a South African attorney)

### Holding and paying out organiser funds
- Does collecting ticket money into VYBE's account and paying organisers later make VYBE a "third-party payment provider" or require a bank/clearing arrangement under the **National Payment System Act 78 of 1998** and the SARB directive on payments to third persons? What changes if a provider does split settlement instead?
- Is a trust or separate account needed for organiser funds? What happens to those funds if VYBE becomes insolvent?
- Does the payout hold policy need to be in the organiser agreement? The policy covers:
  - settle 3 days after the event;
  - holds for risk cases, which are reversible and appealable;
  - deductions for refunds and chargebacks.
  Is it fair and enforceable as written?

### Buyers
- **Consumer Protection Act 68 of 2008:**
  - Is the price display all-inclusive (now yes: no buyer fee)?
  - Does the cancellation and refund policy fit the Act? The policy is: automatic refunds up to 48 hours before the event; full refunds on cancellation or a material change.
  - Who is the supplier of the event: VYBE or the organiser? Section 47 deals with over-selling. VYBE prevents overselling by locking stock, and refunds automatically if a payment lands after stock runs out.
- **ECTA 25 of 2002:**
  - Are the section 43 website disclosures complete (VYBE's legal name, registration, address, contact, terms, privacy)?
  - Does the section 44 cooling-off right apply, or is there an exclusion for leisure services on a specific date?
- Ticket transfer rules (once, to friends only), entry rules, and the right to refuse entry for invalid or used tickets: are they in the buyer terms?

### Organisers
- An organiser agreement that covers:
  - the commission (5 %, VAT treatment);
  - settlement timing, reserves and holds;
  - refunds and chargebacks borne by the organiser up to their net;
  - promoter commissions paid from the organiser's share;
  - event accuracy (lineup claims, material changes);
  - verification evidence;
  - termination.
- Promoter terms. Promoter earnings accrue but **no promoter payout flow exists yet**.

### Tax
- **VAT Act 89 of 1991:** is VYBE required to register at the current threshold (confirm the threshold with SARS)? Once registered, set "VAT registered" and the rate in Admin → Finance. The commission and fee VAT split is already implemented.
- Is the commission VYBE's turnover, while the ticket price is the organiser's? This depends on the agent-or-principal analysis, which also affects the CPA "supplier" question.

### Personal information
- **POPIA 4 of 2013:**
  - privacy notice;
  - lawful basis for order, ticket and scan records;
  - retention periods (audit and financial records are append-only by design);
  - transactional email (now sent through your SMTP provider);
  - cross-border transfer (Supabase and Cloudflare hosting regions);
  - an Information Officer registered with the Information Regulator.
- Exports to organisers contain no buyer emails or phone numbers. Door staff never see ticket codes.

### Anti-fraud and records
- Check that the risk rules and automatic holds fit the organiser and buyer terms. The rules are explainable and appealable.
- Do FICA obligations apply to VYBE's role?
- Record-keeping periods for financial records.

## 4. What stays switched off until the review and provider are done

- **Real payouts.** Payouts are recorded manually (admin approval plus a second admin confirming the bank reference). Do not start paying out real organiser money until section 2 is resolved and section 3 is answered.
- **Live payment mode.** PayFast stays on sandbox (`PAYFAST_SANDBOX=1`) until you decide to go live. Switching to live means changing the credentials and removing that flag. It is your decision, and it should come after the review.
