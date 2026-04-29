# AC Cleaning Marketplace — MVP Roadmap
**WhatsApp-First | Indonesia | Keep It Simple**

---

## What We're Building

A WhatsApp bot that lets a homeowner book an AC cleaning, pay, and rate the worker — with zero human middleman involved.

**Core loop:**
```
Client messages → AI books the job → Payment → Worker does the job → Feedback
```

That's it. Nothing else until this loop works reliably.

---

## MVP Feature Scope

| Feature | In MVP | Out of MVP |
|---|---|---|
| WhatsApp order flow | ✅ | |
| Auto price quote | ✅ | |
| Payment via DANA/GoPay/VA | ✅ | |
| Worker notification (WhatsApp) | ✅ | |
| Worker accept/reject job | ✅ | |
| Post-job feedback (1–5 stars) | ✅ | |
| Worker earnings summary | ✅ | |
| Dynamic pricing / surge | ❌ | Later |
| Algorithm-based matching | ❌ | Later |
| Premium worker listing | ❌ | Later |
| Insurance | ❌ | Later |
| Analytics dashboard | ❌ | Later |
| Native app | ❌ | Never (maybe) |

---

## Tech Stack (Minimal)

| What | Tool | Cost |
|---|---|---|
| WhatsApp API | Wati.io starter | ~$40/month |
| AI bot | Claude API | Pay per use |
| Backend | Node.js on Railway | ~$5/month |
| Database | PostgreSQL (Railway) | Included |
| Payment | Xendit | 1.5% per transaction |
| Worker GPS map | Google Maps link (manual) | Free |
| Admin view | Google Sheet sync | Free |

**Total fixed cost: ~$50/month. Breakeven at ~3 orders/day.**

---

## Roadmap

### Phase 0 — Manual Before Automated (Week 1–2)
> Validate demand. No code yet.

- [ ] Create a WhatsApp Business number
- [ ] Recruit 5 technicians in 1 neighborhood (South Jakarta / Jaksel)
- [ ] Post in 2–3 local Facebook groups / Telegram RT-RW
- [ ] Take the first 10 orders **manually** — you are the bot
- [ ] Track everything in Google Sheet: client, location, units, price, worker, status
- [ ] Collect first feedback via WhatsApp message

**Goal:** 10 completed orders. Proves people will pay.

---

### Phase 1 — Build the Bot (Week 3–6)
> Automate the order flow only.

- [ ] Set up Wati.io WhatsApp Business API
- [ ] Build AI conversation flow:
  - Greet → ask how many units + location + schedule
  - Show price quote
  - Confirm order
- [ ] Generate Xendit payment link automatically
- [ ] On payment confirmed → notify assigned worker via WhatsApp
- [ ] Worker replies "1" to accept, "2" to reject
- [ ] If rejected → you (admin) manually reassign
- [ ] After job done → send 1–5 star rating request to client
- [ ] Store everything in PostgreSQL

**Goal:** 50 orders processed through the bot with zero manual intervention on the order/payment flow.

---

### Phase 2 — Stabilize & Grow Workers (Week 7–10)
> Fix what broke. Add more workers.

- [ ] Worker simple PWA dashboard (earnings, job history, upcoming jobs)
- [ ] Auto daily earnings summary sent to worker at 9PM via WhatsApp
- [ ] Automated 3-month reminder to repeat clients
- [ ] Basic admin dashboard to see live orders, flag problems
- [ ] Grow to 20 workers across 3 zones in Jakarta
- [ ] Fix all the edge cases the first 50 orders revealed

**Goal:** 30 orders/day consistently. Worker churn < 20%.

---

### Phase 3 — Introduce the Algorithm (Week 11–16)
> Only after you have real data.

- [ ] Auto-assign worker based on: proximity + rating + availability
- [ ] No more manual reassignment by admin
- [ ] Worker rating score calculated automatically after every job
- [ ] Automatic low-rating warning to worker (< 3.8 stars)
- [ ] Expand to Tangerang + Bekasi

**Goal:** 100 orders/day. Admin workload under 1 hour/day.

---

### Phase 4 — Monetization Layer (Week 17–24)
> Now you earn more per order.

- [ ] Loyalty points for clients (every 5th job = discount)
- [ ] B2B channel: apartment complexes book monthly recurring jobs
- [ ] Simple referral program: client refers friend = Rp 20K credit
- [ ] Explore Surabaya / Bandung expansion

**Goal:** Rp 500M GMV/month. Platform sustainable without external funding.

---

## Order Flow (Technical)

```
[Client] "cuci AC dong"
    │
    ▼
[Bot] "Halo! Berapa unit AC yang mau dibersihin?"
    │
    ▼
[Client] "2 unit"
    │
    ▼
[Bot] "Lokasi kamu di mana? (kirim lokasi WhatsApp)"
    │
    ▼
[Bot] "Mau jadwalin kapan? (hari ini / besok / pilih tanggal)"
    │
    ▼
[Bot] "Oke! 2 unit AC = Rp 160.000. Bayar sekarang ya?"
    │
    ▼
[Client] konfirmasi → Xendit payment link dikirim
    │
    ▼
[Payment confirmed → funds held in escrow]
    │
    ▼
[Bot → Worker] "Ada order baru! 2 unit, Kebayoran Baru, jam 10:00.
                Kamu dapat Rp 128.000. Reply 1 untuk terima."
    │
    ▼
[Worker] "1"
    │
    ▼
[Bot → Client] "Teknisi kamu: Budi ⭐4.8 — ETA 30 menit.
                Kode konfirmasi kamu: 7284
                Berikan kode ini ke Budi SETELAH pekerjaan selesai."
    │
    ▼
[Worker sends before-photo via WhatsApp → stored]
    │
    ▼
[Worker does the job]
    │
    ▼
[Worker sends after-photo via WhatsApp → stored]
    │
    ▼
[Worker asks client for code → types it into bot]
    │
    ▼
[Bot verifies code ✅] → [Escrow releases → Worker paid instantly]
    │
    ▼
[Bot → Client] "Gimana hasilnya? Kasih rating 1–5"
```

### Anti-Fraud Rules
- OTP expires 6 hours after job scheduled time (auto-cancel protection)
- Worker cannot mark done without valid OTP — no exceptions
- If client claims worker never came: escrow refunded, worker flagged
- 3 fraud flags = permanent worker suspension

---

## Database Schema (MVP Only)

```sql
clients   — id, phone, name, address, created_at
workers   — id, phone, name, zone, rating, status (active/inactive)
orders    — id, client_id, worker_id, units, price, status, scheduled_at
payments  — id, order_id, amount, method, xendit_ref, paid_at
reviews   — id, order_id, score, note, created_at
```

Five tables. That's the whole product.

---

## Key Rules to Not Break

1. **Never touch cash.** All payments via Xendit. Worker gets paid digitally.
2. **One city first.** Do not expand before 100 orders/day in one zone.
3. **Build the algorithm last.** Manual assignment until Phase 3.
4. **Bot fails → human takes over.** Always have an admin WhatsApp as fallback.
5. **Measure one thing:** order completion rate. Everything else is noise at MVP stage.

---

*MVP Roadmap v1.0 — April 2026*
