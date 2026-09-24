# Connecta — Monetization Plan

A realistic path to revenue for a self-hosted text / voice / video calling app.
Nothing here is active yet — this is the plan, the numbers to sanity-check, and
the order to build things in.

---

## 1. The honest starting point

Connecta today is a working, self-hostable app: auth, 1:1 + group chat, 1:1 +
full-mesh group calls, PWA + Electron desktop, Docker deploy, TURN relay, and a
test suite. That is a **cost-efficient communications platform**, not yet a
business. To make money you need three things in this order:

1. **Reach** — people can actually get to it (a public URL, app stores, or both).
2. **Retention** — a reason to keep using it daily (contacts already there,
   notifications, reliability).
3. **A paying reason** — a feature or capacity limit worth upgrading for.

Do not build payments before (1) and (2) exist. Charging for an app nobody can
reach or nobody returns to just adds friction.

---

## 2. Positioning — pick one lane

You cannot out-feature WhatsApp/Zoom for free. Choose a wedge where being
**self-hosted, private, and controllable** is the selling point:

| Lane | Buyer | Why they pay | Fit with current code |
|------|-------|--------------|-----------------------|
| **A. Privacy-first teams / NGOs / clinics** | Orgs that can't put comms on US big-tech | Data residency, no ad profiling, self-host | High — already self-hostable |
| **B. White-label for agencies** | Dev shops reselling "their" chat app | They rebrand your stack per client | High — Electron + PWA rebrand easily |
| **C. Communities / creators** | Course sellers, fan groups, churches | Private paid community space | Medium — needs payments + roles |
| **D. Prosumer "own your calls"** | Individuals leaving big-tech | One-time purchase, self-host | Medium — small market, low ARPU |

**Recommendation: start with B (white-label) + A (privacy teams).** They pay the
most, need the least new consumer-scale infra, and your architecture already
supports per-deployment branding and self-hosting. Consumer (C/D) is a later
play once you can absorb scale costs.

---

## 3. Pricing model

### Freemium SaaS (hosted by you)
| Tier | Price | Limits | Notes |
|------|-------|--------|-------|
| **Free** | $0 | 1:1 unlimited, group calls ≤ 4 people, 30-min call cap, 7-day message history | TURN metered — this is your real cost |
| **Plus** | $6/user/mo | Group calls ≤ 25, no time cap, full history, file share, priority TURN | The main consumer upgrade |
| **Team** | $12/user/mo | SSO, admin console, audit log, data residency, SLA | Lane A |
| **Business** | Custom | Dedicated instance / on-prem, custom branding, support contract | Lane B |

### Self-hosted license (one-time / annual)
| Product | Price | What they get |
|---------|-------|---------------|
| **Community** | Free (open core) | The current stack, self-hosted, no support |
| **Self-Host Pro** | $499 one-time or $199/yr | Branding removal, mobile push keys, priority support, upgrade path |
| **White-label** | $2,500–$10,000/yr | Full rebrand, per-client deploys, source access, SLA |

Anchor the free tier's group-call cap to your **TURN bandwidth cost** — that is
the one thing that scales with usage and can bankrupt you if unmetered.

---

## 4. Revenue channels (beyond subscriptions)

1. **Hosted subscription** — the recurring core (above).
2. **White-label licensing** — highest margin, lowest support load. Sell the
   stack to agencies who deploy it per client.
3. **Managed TURN / media relay** — resell bandwidth with markup. Metered, so
   it maps directly to cost. This alone can be a product ("bring your own app,
   use our relay").
4. **One-time self-host license** — cash from users who refuse SaaS.
5. **Add-ons** — recording/storage, extra seats, SMS/email verification packs,
   custom integrations, paid support hours.
6. **App-store IAP** — only if you ship iOS/Android; note stores take 15–30% and
   require the billing to go through them for digital goods.

---

## 5. Cost structure (what eats margin)

| Cost | Driver | Control |
|------|--------|---------|
| **TURN relay bandwidth** | Group calls, users behind strict NATs | Meter it; cap free tier; prefer P2P where possible; consider an SFU for large rooms |
| **Compute/hosting** | Concurrent connections, WS signaling | One Node box handles a lot; scale horizontally later |
| **Database** | Message volume | SQLite is free now; Postgres/Supabase when multi-instance |
| **Push notifications** | Mobile DAU | FCM/APNs are ~free; you supply keys |
| **App-store fees** | IAP revenue | 15–30% — price around it or bill off-store where allowed |
| **Support** | Paying customers | Time — the real cost of white-label/team tiers |

**Key insight:** your marginal cost per *chat* user is near zero; per *call*
user it's TURN bandwidth. Price calls, not chats.

---

## 6. Build order (what to ship, and when)

**Phase 0 — Reach (before charging anything)**
- Public deploy (the existing Docker compose) behind a domain + TLS.
- Analytics on signups / DAU / calls-per-user (privacy-respecting, e.g. Plausible).
- A landing page with a "hosted" signup and a "self-host" download.

**Phase 1 — Metering + the free/paid line**
- Track TURN minutes + group-call size per account.
- Enforce free-tier caps in `ws.js` (reject >N participants, end at time cap).
- Stripe billing (Checkout + customer portal) for Plus/Team. Feature-flag by tier.

**Phase 2 — The paid features people upgrade for**
- File/media sharing, message history retention by tier.
- Larger group calls → needs an **SFU** (full-mesh dies past ~6 peers).
- Admin console + SSO for Team.

**Phase 3 — White-label / self-host licensing**
- Theming config (name, logo, colors) driven by env/config.
- License keys + a build that phones home for entitlement.
- Per-client deploy tooling (Terraform/compose templates).

---

## 7. Numbers to sanity-check (illustrative)

Assume hosted SaaS, free-to-paid conversion 2–4% (typical for comms freemium):

- 10,000 free users → ~250 paying @ $8 avg → **~$2,000 MRR**.
- TURN cost: if a paying user does ~300 relay-min/mo at ~$0.004/min → ~$1.2/user
  → margin holds, but free-tier call caps are what protect you.
- One white-label deal ($5k/yr) ≈ 50 hosted subscribers. **Chase white-label
  early** — fewer, larger, stickier.

Break-even is dominated by TURN + your time. Keep the free tier's calling
metered and the model works at small scale.

---

## 8. Legal / compliance (don't skip)

- **Terms + Privacy policy** on the hosted site; a **DPA** for Team/white-label.
- **E2E encryption**: you currently relay signaling and TURN media — be honest
  in marketing about what is and isn't E2EE. True E2EE is a big lift
  (double-ratchet, key management) and a differentiator for Lane A.
- **Data residency / deletion** (GDPR/CCPA): export + delete-account endpoints.
- **Call recording** (if you add it): consent laws vary — two-party-consent
  regions require notifying all participants.
- **Age / abuse**: reporting + blocking; app stores require this.
- **Business**: an entity, and tax handling on subscriptions (Stripe Tax helps).

---

## 9. Fastest first dollar

If you want revenue with the least new code:

1. Put the current Docker stack on a $10–20/mo VPS with a domain + TLS.
2. Sell **white-label / self-hosted Pro** to 2–3 agencies or privacy-focused
   orgs directly (cold outreach, Upwork, indie-hacker communities). This needs
   branding config + a license key, not a billing empire.
3. Use that cash and feedback to decide whether hosted consumer SaaS (and the
   SFU + Stripe build) is worth it.

That path monetizes the architecture you already have instead of betting on
consumer scale you'd have to buy.
