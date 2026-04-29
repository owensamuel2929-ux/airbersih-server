# AC Cleaning Marketplace — System Architecture
**Indonesia Market | WhatsApp-First | AI-Automated Operations**

---

## 1. Vision & Business Model

### Core Premise
A lean, AI-operated platform that connects homeowners with verified AC technicians in Indonesia — with zero app downloads, zero call centers, and a commission structure that undercuts every existing player.

### Revenue Model
| Stream | Rate | Notes |
|---|---|---|
| Transaction fee (client) | 5% | Baked into service price — invisible |
| Transaction fee (worker) | 8% | vs. 25–35% on Sejasa/competitor |
| Premium worker listing | Rp 99K/month | Boosted visibility in algorithm |
| Insurance micro-product | Rp 15K/job | Partner with Lifepal or PasarPolis |
| Data analytics B2B | Per contract | Sell demand heatmaps to AC brands (Daikin, Panasonic) |

### Unit Economics Target (Year 1)
- Average order value: Rp 120,000–180,000
- Platform take: ~Rp 20,000–25,000 per job
- Target: 500 jobs/day in 1 city = Rp 10M/day GMV
- Break-even: ~150 jobs/day (lean ops, no physical office)

---

## 2. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT LAYER                            │
│          WhatsApp Chat  ←→  Web Fallback (PWA)                  │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTPS / Webhook
┌────────────────────────▼────────────────────────────────────────┐
│                     AI GATEWAY LAYER                            │
│   WhatsApp Business API (360dialog / Wati / Twilio)             │
│   + NLP Intent Router (Claude API / GPT-4o)                     │
│   + Conversation State Manager (Redis)                          │
└────┬───────────────┬──────────────────┬──────────────┬──────────┘
     │               │                  │              │
┌────▼────┐  ┌───────▼──────┐  ┌───────▼────┐  ┌────▼────────┐
│  Order  │  │   Payment    │  │  Matching  │  │  Feedback   │
│ Service │  │   Service    │  │  Engine    │  │  & Review   │
└────┬────┘  └───────┬──────┘  └───────┬────┘  └────┬────────┘
     │               │                  │              │
┌────▼───────────────▼──────────────────▼──────────────▼────────┐
│                      CORE DATABASE LAYER                       │
│   PostgreSQL (orders, users, workers)                          │
│   Redis (session state, queue, cache)                          │
│   Pinecone / pgvector (worker embeddings for matching)         │
└───────────────────────────────┬───────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────┐
│                    WORKER MOBILE LAYER                         │
│         WhatsApp Notifications + Simple PWA Dashboard          │
│         (job accept/reject, navigation, earnings view)         │
└────────────────────────────────────────────────────────────────┘
```

---

## 3. User Journey — Client Side

```
Client sends "cuci AC" on WhatsApp
         │
         ▼
AI greets, asks: berapa unit? lokasi? kapan?
         │
         ▼
AI confirms order summary + price quote
         │
         ▼
Payment link sent (DANA / GoPay / OVO / VA)
         │
         ▼
Payment confirmed → funds held in escrow → worker assigned
         │
         ▼
Client receives: worker name, rating, ETA
         + 4-digit OTP code via WhatsApp
         "Kode konfirmasi kamu: 7284 — berikan ke teknisi SETELAH selesai"
         │
         ▼
Worker arrives, does the job
         │
         ▼
Client gives OTP to worker → worker submits code to bot
         │
         ▼
Bot verifies OTP → escrow releases → worker paid instantly
         │
         ▼
Client rates 1–5 stars
         │
         ▼
Receipt sent automatically
```

---

## 4. User Journey — Worker Side

```
Worker receives job offer via WhatsApp
  (location, unit count, time, earnings breakdown)
         │
         ▼
Worker accepts (reply "1") or rejects (reply "2")
         │
         ▼
Google Maps link auto-sent for navigation
         │
         ▼
Worker sends BEFORE photo via WhatsApp on arrival
         │
         ▼
Worker does the job
         │
         ▼
Worker sends AFTER photo via WhatsApp
         │
         ▼
Worker asks client for OTP → submits to bot
         │
         ▼
OTP verified → payment released to worker instantly
         │
         ▼
Worker sees daily earnings summary at 9PM
```

---

## 5. AI Layer — Detailed Breakdown

### 5.1 NLP Intent Router
- **Engine:** Claude API (Sonnet 4.x) or GPT-4o
- **Languages:** Bahasa Indonesia + Javanese/Betawi slang recognition
- **Intents handled:**
  - `order.new` — new service request
  - `order.reschedule` — change schedule
  - `order.cancel` — cancellation flow
  - `payment.check` — payment status inquiry
  - `complaint.raise` — escalation trigger
  - `small_talk` — casual replies to keep engagement warm
- **Fallback:** After 2 failed intent detections → escalate to human agent queue

### 5.2 Matching Engine (Worker–Job Pairing)
```
Input signals:
  - Client GPS coordinates
  - Requested time slot
  - Number of AC units
  - Worker current availability status
  - Worker historical rating (weighted 60-day rolling)
  - Worker job completion rate
  - Worker proximity (Haversine distance)
  - Worker peak load (avoid overloading top workers)

Scoring formula:
  score = (0.35 × proximity_score)
        + (0.30 × rating_score)
        + (0.20 × availability_score)
        + (0.15 × completion_rate_score)

Output: Top 3 candidates → offer sent to #1 first
        If rejected/no response in 90s → offer to #2
```

### 5.3 Dynamic Pricing Engine
```
base_price = Rp 75,000 per unit (standard split AC)

multipliers:
  peak_hour (7–9AM, 4–7PM)    × 1.2
  weekend                      × 1.15
  low_supply_area              × 1.3  (< 3 workers available)
  high_demand_surge            × 1.25 (> 20 orders/hr in zone)
  loyalty_discount             × 0.9  (5th+ order)

final_price displayed to client before confirmation
```

### 5.4 Feedback & Quality AI
- Post-job survey sent 30 minutes after job completion
- Sentiment analysis on free-text reviews (flag negative patterns)
- Worker performance score recalculated after every 5 jobs
- Automated warning sent to worker at score < 3.8
- Automatic suspension trigger at score < 3.2 (with human review gate)

---

## 6. Payment Architecture

```
Client pays
    │
    ▼
Payment Gateway (Xendit)
    │ — supports: GoPay, OVO, DANA, BCA VA, BRI VA, Mandiri VA, QRIS
    ▼
Escrow Hold — funds locked until OTP confirmed
    │
    ▼
Client gives 4-digit OTP to worker after job is done
    │
    ▼
Worker submits OTP to bot → bot verifies
    │
    ▼
Escrow releases → Worker paid instantly (T+0)
    │
    ▼
Platform fee retained automatically
    │
    ▼
Daily earnings summary sent to worker at 9PM
```

### OTP Anti-Fraud Rules
- OTP generated at payment confirmation, valid for 6 hours
- Worker cannot trigger payment release — only OTP submission counts
- Client reports no-show → full refund, worker flagged for review
- 3 fraud flags (fake completion) → permanent worker suspension
- Before/after photos stored per job as dispute evidence

**No cash handling. Ever. This is non-negotiable for fraud control.**

---

## 7. Data Architecture

### 7.1 Core Tables (PostgreSQL)
```sql
clients       — id, phone, name, address, gps_default, created_at
workers       — id, phone, name, zone_ids[], rating, completion_rate, fraud_flags, status
orders        — id, client_id, worker_id, units, price, status, otp_code, otp_expires_at,
                scheduled_at, completed_at
payments      — id, order_id, method, amount, xendit_ref, escrow_status, released_at
photos        — id, order_id, worker_id, type (before/after), url, uploaded_at
reviews       — id, order_id, score, note, created_at
```

### 7.2 Event Stream (for AI training & analytics)
- All WhatsApp messages logged (anonymized) → S3/GCS
- Funnel events: intent_detected → order_confirmed → payment_done → completed → reviewed
- Used to retrain intent classifier quarterly

---

## 8. Tech Stack Recommendation

| Layer | Technology | Why |
|---|---|---|
| WhatsApp API | Wati.io or 360dialog | Indonesian support, affordable |
| AI/NLP | Claude API (Anthropic) | Best Bahasa Indonesia comprehension |
| Backend | Node.js (Fastify) or Python (FastAPI) | Fast async, easy AI integration |
| Database | PostgreSQL + PostGIS | Geo queries for worker matching |
| Cache/Queue | Redis + BullMQ | Job queue, session state |
| Payment | Xendit | Best Indonesian coverage + escrow |
| Hosting | Railway or Fly.io (MVP) → AWS Jakarta (scale) | AWS ap-southeast-3 for data residency |
| Monitoring | Sentry + Grafana | Error tracking + ops dashboard |
| Analytics | Metabase (internal) | Non-technical team can query |

---

## 9. Operational Zones — Rollout Strategy

### Phase 1 (Month 1–3): Single City Depth
- **Target: South Jakarta (Jaksel)**
- Rationale: Highest AC density, highest income bracket, most forgiving of early bugs
- Worker target: 30 verified technicians
- Order target: 20 jobs/day → 500 jobs/day by end of Month 3

### Phase 2 (Month 4–8): Greater Jakarta
- Expand to Tangerang, Bekasi, Depok
- Introduce worker tiering (Bronze/Silver/Gold)
- Launch B2B channel (apartment complexes, offices)

### Phase 3 (Month 9–18): Tier 1 Cities
- Surabaya, Bandung, Medan
- Franchise/partnership model for worker supply (partner with existing AC repair shops)

---

## 10. Competitive Moat (How You Stay Ahead)

| Advantage | Description |
|---|---|
| **Worker financial identity** | You own their payment history, ratings, job count — creates lock-in |
| **Demand data** | You know which buildings, which zones need cleaning when — no competitor has this |
| **WhatsApp-native UX** | Switching cost is near-zero for clients but your AI conversation memory creates stickiness |
| **Sub-10% commission** | Structurally cheaper to operate — workers will evangelize for you |
| **Recurring order AI** | After job 1, AI proactively messages client at the 3-month mark — zero CAC on repeat orders |

---

## 11. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Worker marks done without showing up | OTP system — client controls escrow release, not worker |
| Client collusion (gives OTP before job done) | Before/after photos stored as dispute evidence |
| Worker dispute ("I did the job but no OTP") | Admin reviews photos + client message history |
| WhatsApp Business API policy changes | Build PWA fallback from day 1; own the phone number relationship |
| Worker quality inconsistency | Video-verified onboarding + first 3 jobs shadowed/spot-checked |
| Cash demand from workers | Instant T+0 disbursement removes incentive for cash |
| Copycat by Gojek/Grab | Go deep vertical fast — own worker relationships before they notice |
| OJK payment regulation | Use licensed payment partner (Xendit) — don't hold float yourself |

---

## 12. MVP Scope (Build This First)

**8-week MVP — validate before you build everything:**

- [ ] WhatsApp bot with 3 intents: `order.new`, `payment.check`, `order.status`
- [ ] Manual matching (you assign the worker) — skip the algorithm until Week 6
- [ ] Xendit payment link + escrow hold
- [ ] OTP generation on payment confirmation → sent to client
- [ ] Worker submits OTP → escrow releases automatically
- [ ] Worker before/after photo submission via WhatsApp
- [ ] Worker notification via WhatsApp (accept/reject)
- [ ] Post-job rating (1–5 stars via WhatsApp buttons)

**Do not build the algorithm, dynamic pricing, or analytics until you have 200+ completed orders. Data first.**

---

*Architecture Version 1.1 — April 2026*
*Market: Indonesia | Stack: WhatsApp-First + AI-Automated*
