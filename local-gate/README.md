# VYBE local gate (venue Wi-Fi admission)

A small program that lets a venue keep admitting people **without internet**, as long as the door phones share the venue's own Wi-Fi. One computer runs it; every door phone scans through it, so it is the single place that decides and a ticket is admitted **once** across all gates connected to it.

Status: implemented and tested in this repository (`tests/unit/local-gate.test.ts`, including 50 phones scanning one ticket at once). **Not yet deployed or tested at a real venue** with real phones, a real access point and real certificates.

## When to use it

Set the event's door mode to **Venue network** (event page → Entry, gates & seating → "If the internet fails at the venue"). The organiser must write an operating plan and an end time.

| Mode | Who decides | Ticket admitted once? |
| --- | --- | --- |
| Online only (default) | VYBE's server | Yes, across every phone |
| Venue network (this) | This gate | Yes, across every phone paired to this gate. Scans made elsewhere (online phones, another gate box) are only compared when the ledger is uploaded. |
| Independent offline phones | Each phone alone | **No**. A copied ticket can get in once per phone; found only after upload. |

## What you need

- A laptop or mini-PC with Node.js 22.6 or newer and a reliable battery or UPS.
- A Wi-Fi access point or router for the door phones, on its own network (SSID and password), not shared with the public. If possible, isolate it from guest Wi-Fi and allow only the gate computer's port.
- A TLS certificate for the gate computer's address. Phone cameras only work on HTTPS pages. Options: a certificate for a local DNS name you control, or a self-signed certificate that each door phone trusts once. Without TLS the gate still works with **typed codes only**.
- A supervisor phone with VYBE (signed in, on the door team as a supervisor) and internet **before** doors open.

## Before doors open (with internet)

1. In VYBE, open the event's **Door scanner** on the supervisor phone, choose the gate, then **Load offline data**, then **Save file for the local gate**. The file holds, for this event's paid tickets: ticket id, credential version, a per-ticket key (to check the live QR), a hash of the static code, the reference, the category, the zones, the seat label, the entry window and whether it was already used. It holds **no names, emails, phone numbers or payment data**. Treat it as sensitive: anyone holding it could make valid-looking QR codes for this event's tickets until they are uploaded and reconciled.
2. Copy the file to the gate computer and start the gate:

   ```sh
   MANIFEST=vybe-gate-xxxx.json PAIRING_PIN=482913 ADMIN_PIN=73920481 \
   TLS_CERT=gate.crt TLS_KEY=gate.key PORT=8443 \
   node local-gate/gate.mjs
   ```

   - `PAIRING_PIN` (6+ digits): what door staff type once to pair their phone. Five wrong tries lock that device out for 5 minutes.
   - `ADMIN_PIN` (8+ digits, different): for the supervisor's export and revoking a phone.
   - `LEDGER` (default `ledger.jsonl`) and `STATE` (default `gate-state.json`) are written next to where you start it. Keep them until the ledger is uploaded.
3. On each door phone, join the door Wi-Fi, open `https://<gate computer address>:8443/`, type the pairing PIN, then scan.
4. Check `https://<address>:8443/health`: it shows the event, the gate, tickets loaded, admitted so far and whether the data has expired.

The gate data expires at the time the organiser set (at most 12 hours after loading). After that the gate admits nobody until fresh data is loaded.

## During the event

- Answers on the phones: ADMIT, ALREADY USED, INVALID, NOT YET VALID, ENTRY CLOSED, WRONG GATE, HOLD — SUPERVISOR, QR EXPIRED, GATE DATA EXPIRED, and "NOT VERIFIED — DO NOT ADMIT" when the gate did not answer.
- Re-entry and session tickets, and reserved-seat tickets without a seat, are sent to a supervisor (HOLD).
- Every decision is written to the ledger and flushed to disk **before** the phone gets the answer. A power cut loses nothing that was answered; on restart the ledger is replayed.
- A lost phone: `curl -X POST -H "x-admin-pin: $ADMIN_PIN" -d '{"device":"<id>"}' https://<address>:8443/revoke` (device ids are in `gate-state.json`).

## If the gate computer fails

Admission stops at that gate box (phones show NOT VERIFIED). Options, in order: restart it (the ledger is replayed); move door staff to online scanning if internet is back; switch the organiser to **Independent offline phones** only if the written plan allows it, accepting the duplicate-entry risk.

## After the event (with internet)

1. On the gate computer: `curl -H "x-admin-pin: $ADMIN_PIN" https://<address>:8443/export > ledger-export.json`.
2. In VYBE, Door scanner → **Upload venue ledger** → choose the file. Each scan is uploaded once (re-uploading changes nothing). An acceptance becomes a confirmed admission only if VYBE has no other entry for that ticket; otherwise a **conflict case** opens in the event's Scan investigation, with both records kept.
3. Delete the manifest, ledger, state and export files from the gate computer once the upload is confirmed (they are covered by the retention schedule in `docs/tickets-operations-report.md`).

## Security notes

- The gate serves only on the address you give it; put it on the door network, not the public one.
- Pairing tokens are random 256-bit values held in `gate-state.json`; anyone with that file and network access can scan. Keep the computer locked.
- The gate does not learn about refunds, transfers or revocations made after the manifest was saved. Reload the data close to doors opening.
- The gate never sends anything to the internet. The ledger reaches VYBE only when a supervisor uploads it.
