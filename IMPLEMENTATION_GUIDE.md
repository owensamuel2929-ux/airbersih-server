# Implementation Guide — AC Cleaning Marketplace
**For a Solo Developer | Node.js + WhatsApp + Claude API + Xendit**

---

## Stack Decision

| Layer | Tool | Why |
|---|---|---|
| Runtime | Node.js + Express | Simple, fast to build |
| Language | TypeScript | Catch bugs early, worth the setup |
| Database | PostgreSQL on Railway | One platform, easy deploy |
| Session/Queue | Upstash Redis | Serverless, free tier is enough for MVP |
| WhatsApp API | Wati.io | Best REST API, affordable |
| AI/NLP | Claude API (Anthropic) | Best Bahasa Indonesia |
| Payment | Xendit | Escrow + instant disbursement |
| File Storage | Cloudinary | Free 25GB, easy WhatsApp media upload |
| Hosting | Railway | Deploy from GitHub, cheap |

---

## Step 1 — Register All Accounts First (Day 1)

Do this before writing a single line of code. All of these have free tiers or trials.

1. **Railway** → railway.app (host your backend + PostgreSQL)
2. **Wati.io** → wati.io (WhatsApp Business API — start with trial)
3. **Xendit** → xendit.co (payment — sandbox mode first)
4. **Anthropic** → console.anthropic.com (Claude API key)
5. **Cloudinary** → cloudinary.com (photo storage)
6. **Upstash** → upstash.com (serverless Redis)

Keep all API keys in a `.env` file. Never commit it.

```env
# .env
PORT=3000
DATABASE_URL=postgresql://...
REDIS_URL=redis://...

WATI_API_URL=https://live-mt-server.wati.io/xxxxx
WATI_ACCESS_TOKEN=your_token

ANTHROPIC_API_KEY=sk-ant-...

XENDIT_SECRET_KEY=xnd_development_...
XENDIT_WEBHOOK_TOKEN=your_webhook_token

CLOUDINARY_URL=cloudinary://...
```

---

## Step 2 — Initialize the Project (Day 1–2)

```bash
mkdir ac-marketplace && cd ac-marketplace
npm init -y
npm install express typescript ts-node @types/node @types/express
npm install pg redis axios @anthropic-ai/sdk xendit-node cloudinary
npm install dotenv zod
npx tsc --init
```

### Project Structure
```
src/
  index.ts              # Express server entry
  routes/
    webhook.ts          # WhatsApp incoming messages
    xendit.ts           # Payment callbacks
  services/
    ai.ts               # Claude intent detection
    conversation.ts     # Conversation state manager
    order.ts            # Order creation logic
    payment.ts          # Xendit escrow + OTP
    worker.ts           # Worker notification
    photo.ts            # Cloudinary upload
  db/
    index.ts            # PostgreSQL connection
    schema.sql          # Table definitions
  utils/
    otp.ts              # OTP generator
    whatsapp.ts         # Send WhatsApp message helper
```

---

## Step 3 — Set Up the Database (Day 2)

Create `src/db/schema.sql` and run it on your Railway PostgreSQL instance.

```sql
CREATE TABLE clients (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(100),
  address TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE workers (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  zone VARCHAR(50),
  rating DECIMAL(2,1) DEFAULT 5.0,
  completion_rate DECIMAL(3,2) DEFAULT 1.0,
  fraud_flags INT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active'
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  client_id INT REFERENCES clients(id),
  worker_id INT REFERENCES workers(id),
  units INT NOT NULL,
  price INT NOT NULL,
  status VARCHAR(30) DEFAULT 'pending_payment',
  otp_code VARCHAR(6),
  otp_expires_at TIMESTAMP,
  scheduled_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  order_id INT REFERENCES orders(id),
  method VARCHAR(30),
  amount INT NOT NULL,
  xendit_ref VARCHAR(100),
  escrow_status VARCHAR(20) DEFAULT 'holding',
  released_at TIMESTAMP
);

CREATE TABLE photos (
  id SERIAL PRIMARY KEY,
  order_id INT REFERENCES orders(id),
  worker_id INT REFERENCES workers(id),
  type VARCHAR(10) NOT NULL, -- 'before' or 'after'
  url TEXT NOT NULL,
  uploaded_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  order_id INT REFERENCES orders(id),
  score INT NOT NULL CHECK (score BETWEEN 1 AND 5),
  note TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

Connect in `src/db/index.ts`:

```typescript
import { Pool } from 'pg';

export const db = new Pool({ connectionString: process.env.DATABASE_URL });
```

---

## Step 4 — WhatsApp Webhook (Day 3)

Wati.io sends a POST to your server every time a client messages you.

```typescript
// src/routes/webhook.ts
import { Router } from 'express';
import { handleMessage } from '../services/conversation';

const router = Router();

router.post('/webhook/whatsapp', async (req, res) => {
  const { waId, text, type, media } = req.body;
  // waId = phone number of sender
  // type = 'text' | 'image' | 'location' | 'interactive'

  res.sendStatus(200); // always ACK fast

  await handleMessage({
    phone: waId,
    text: text?.body || '',
    type,
    media: media || null,
  });
});

export default router;
```

**In Wati.io dashboard:** set webhook URL to `https://your-railway-url.railway.app/webhook/whatsapp`

---

## Step 5 — Conversation State (Day 3–4)

Every user's conversation needs to track where they are in the flow. Store this in Redis.

```typescript
// src/services/conversation.ts
import { redis } from '../db/redis';
import { detectIntent } from './ai';
import { startOrderFlow, continueOrderFlow } from './order';

interface ConversationState {
  step: string;        // 'idle' | 'ask_units' | 'ask_location' | 'ask_time' | 'confirm' | 'await_otp'
  orderId?: number;
  data: Record<string, any>;
}

export async function getState(phone: string): Promise<ConversationState> {
  const raw = await redis.get(`conv:${phone}`);
  return raw ? JSON.parse(raw) : { step: 'idle', data: {} };
}

export async function setState(phone: string, state: ConversationState) {
  await redis.set(`conv:${phone}`, JSON.stringify(state), { EX: 3600 }); // 1hr TTL
}

export async function handleMessage({ phone, text, type, media }: any) {
  const state = await getState(phone);

  // Worker OTP submission is always priority
  if (/^\d{4,6}$/.test(text.trim()) && state.step === 'await_otp') {
    return handleOtpSubmission(phone, text.trim());
  }

  // If mid-conversation, continue the flow
  if (state.step !== 'idle') {
    return continueOrderFlow(phone, text, state);
  }

  // Fresh message — detect intent
  const intent = await detectIntent(text);

  if (intent === 'order.new') return startOrderFlow(phone);
  if (intent === 'order.status') return handleOrderStatus(phone);
  if (intent === 'payment.check') return handlePaymentCheck(phone);

  // Fallback
  await sendWhatsApp(phone, 'Halo! Ketik "cuci AC" untuk pesan layanan. 😊');
}
```

---

## Step 6 — AI Intent Detection (Day 4)

```typescript
// src/services/ai.ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function detectIntent(text: string): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 50,
    system: `Kamu adalah intent classifier untuk layanan cuci AC.
Classify pesan pengguna ke salah satu intent berikut:
- order.new (mau pesan cuci AC)
- order.status (tanya status order)
- order.cancel (mau batalkan order)
- payment.check (tanya status pembayaran)
- small_talk (percakapan biasa)

Balas HANYA dengan nama intent, tanpa penjelasan.`,
    messages: [{ role: 'user', content: text }],
  });

  return (response.content[0] as any).text.trim().toLowerCase();
}

export async function generateReply(context: string, userMessage: string): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: `Kamu adalah asisten WhatsApp untuk layanan cuci AC bernama "AirBersih".
Balas dalam Bahasa Indonesia yang ramah dan singkat.
Konteks percakapan saat ini: ${context}`,
    messages: [{ role: 'user', content: userMessage }],
  });

  return (response.content[0] as any).text.trim();
}
```

---

## Step 7 — Order Flow (Day 5–6)

```typescript
// src/services/order.ts
import { db } from '../db';
import { getState, setState } from './conversation';
import { sendWhatsApp } from '../utils/whatsapp';
import { createPaymentLink } from './payment';

const PRICE_PER_UNIT = 80000; // Rp 80.000

export async function startOrderFlow(phone: string) {
  await setState(phone, { step: 'ask_units', data: {} });
  await sendWhatsApp(phone,
    'Halo! Selamat datang di AirBersih 🌬️\n\nBerapa unit AC yang mau dibersihin?'
  );
}

export async function continueOrderFlow(phone: string, text: string, state: any) {
  switch (state.step) {

    case 'ask_units': {
      const units = parseInt(text);
      if (isNaN(units) || units < 1 || units > 10) {
        return sendWhatsApp(phone, 'Mohon masukkan angka antara 1–10.');
      }
      await setState(phone, { step: 'ask_location', data: { units } });
      await sendWhatsApp(phone, 'Oke! Kirim lokasi kamu ya (pakai fitur "Kirim Lokasi" di WhatsApp).');
      break;
    }

    case 'ask_location': {
      // Wati sends location as text: "lat,lng" or user types address
      const location = text;
      await setState(phone, { step: 'ask_time', data: { ...state.data, location } });
      await sendWhatsApp(phone,
        'Kapan mau dijadwalkan?\n\n1. Hari ini\n2. Besok\n3. Pilih tanggal lain\n\nBalas dengan angka.'
      );
      break;
    }

    case 'ask_time': {
      const timeMap: Record<string, string> = {
        '1': 'Hari ini',
        '2': 'Besok',
      };
      const schedule = timeMap[text] || text;
      const { units } = state.data;
      const price = units * PRICE_PER_UNIT;

      await setState(phone, { step: 'confirm', data: { ...state.data, schedule, price } });
      await sendWhatsApp(phone,
        `📋 *Ringkasan Order*\n\n` +
        `Unit AC: ${units}\n` +
        `Jadwal: ${schedule}\n` +
        `Total: Rp ${price.toLocaleString('id-ID')}\n\n` +
        `Konfirmasi? Balas *YA* untuk lanjut bayar.`
      );
      break;
    }

    case 'confirm': {
      if (text.toLowerCase() !== 'ya') {
        await setState(phone, { step: 'idle', data: {} });
        return sendWhatsApp(phone, 'Order dibatalkan. Ketik "cuci AC" kalau mau pesan lagi ya!');
      }

      // Create order in DB
      let client = await db.query('SELECT id FROM clients WHERE phone = $1', [phone]);
      if (!client.rows.length) {
        client = await db.query(
          'INSERT INTO clients (phone) VALUES ($1) RETURNING id', [phone]
        );
      }
      const clientId = client.rows[0].id;

      const { units, price, schedule } = state.data;
      const order = await db.query(
        `INSERT INTO orders (client_id, units, price, status, scheduled_at)
         VALUES ($1, $2, $3, 'pending_payment', NOW())
         RETURNING id`,
        [clientId, units, price]
      );
      const orderId = order.rows[0].id;

      // Generate Xendit payment link
      const paymentLink = await createPaymentLink(orderId, phone, price);

      await setState(phone, { step: 'idle', data: {} });
      await sendWhatsApp(phone,
        `✅ Order #${orderId} dibuat!\n\nSilakan bayar via link berikut:\n${paymentLink}\n\nLink berlaku 1 jam.`
      );
      break;
    }
  }
}
```

---

## Step 8 — Payment + OTP (Day 7–8)

```typescript
// src/services/payment.ts
import Xendit from 'xendit-node';
import { db } from '../db';
import { generateOTP } from '../utils/otp';
import { sendWhatsApp } from '../utils/whatsapp';
import { notifyWorker } from './worker';

const xendit = new Xendit({ secretKey: process.env.XENDIT_SECRET_KEY! });
const { Invoice } = xendit;

export async function createPaymentLink(orderId: number, phone: string, amount: number) {
  const invoice = await Invoice.createInvoice({
    externalID: `order-${orderId}`,
    amount,
    payerEmail: `${phone}@placeholder.com`,
    description: `AirBersih - Order #${orderId}`,
    invoiceDuration: 3600,
    successRedirectURL: 'https://wa.me/yourwalink',
  });
  return invoice.invoiceUrl;
}

// Called by Xendit webhook when payment is confirmed
export async function handlePaymentConfirmed(xenditRef: string, externalId: string) {
  const orderId = parseInt(externalId.replace('order-', ''));

  // Store payment record
  await db.query(
    `INSERT INTO payments (order_id, xendit_ref, amount, escrow_status)
     SELECT id, $1, price, 'holding' FROM orders WHERE id = $2`,
    [xenditRef, orderId]
  );

  // Update order status
  await db.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [orderId]);

  // Generate OTP
  const otp = generateOTP();
  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6 hours
  await db.query(
    `UPDATE orders SET otp_code = $1, otp_expires_at = $2 WHERE id = $3`,
    [otp, expiresAt, orderId]
  );

  // Get client phone
  const result = await db.query(
    `SELECT c.phone FROM orders o JOIN clients c ON o.client_id = c.id WHERE o.id = $1`,
    [orderId]
  );
  const clientPhone = result.rows[0].phone;

  // Send OTP to client
  await sendWhatsApp(clientPhone,
    `✅ Pembayaran diterima!\n\n` +
    `*Kode konfirmasi kamu: ${otp}*\n\n` +
    `Berikan kode ini ke teknisi SETELAH pekerjaan selesai. Jangan berikan sebelum AC bersih!`
  );

  // Assign worker (manual for MVP — admin gets notified)
  await notifyWorker(orderId);
}

export async function verifyOtpAndRelease(workerPhone: string, otp: string) {
  // Find order assigned to this worker with matching OTP
  const result = await db.query(
    `SELECT o.id, o.price, w.id as worker_id, w.phone
     FROM orders o
     JOIN workers w ON o.worker_id = w.id
     WHERE w.phone = $1
       AND o.otp_code = $2
       AND o.otp_expires_at > NOW()
       AND o.status = 'in_progress'`,
    [workerPhone, otp]
  );

  if (!result.rows.length) {
    await sendWhatsApp(workerPhone, '❌ Kode tidak valid atau sudah kadaluarsa.');
    return;
  }

  const { id: orderId, price, worker_id } = result.rows[0];
  const workerEarnings = Math.floor(price * 0.87); // platform takes 13%

  // Release escrow
  await db.query(
    `UPDATE payments SET escrow_status = 'released', released_at = NOW() WHERE order_id = $1`,
    [orderId]
  );
  await db.query(
    `UPDATE orders SET status = 'completed', completed_at = NOW() WHERE id = $1`,
    [orderId]
  );

  // In production: call Xendit disbursement API here
  // For MVP: manual disbursement, just notify admin

  await sendWhatsApp(workerPhone,
    `✅ Order #${orderId} selesai!\nPendapatan kamu: Rp ${workerEarnings.toLocaleString('id-ID')}\nWill be disbursed in 30 minutes.`
  );

  // Ask client for rating
  const clientResult = await db.query(
    `SELECT c.phone FROM orders o JOIN clients c ON o.client_id = c.id WHERE o.id = $1`,
    [orderId]
  );
  await sendWhatsApp(clientResult.rows[0].phone,
    `AC kamu sudah bersih! 🎉\n\nGimana pelayanannya?\nBalas dengan angka 1–5\n\n5 = Sangat puas\n1 = Tidak puas`
  );
}
```

---

## Step 9 — OTP Generator Utility

```typescript
// src/utils/otp.ts
export function generateOTP(): string {
  return Math.floor(1000 + Math.random() * 9000).toString(); // 4 digits
}
```

---

## Step 10 — Worker Notification (Day 9)

```typescript
// src/services/worker.ts
import { db } from '../db';
import { sendWhatsApp } from '../utils/whatsapp';

export async function notifyWorker(orderId: number) {
  // For MVP: notify admin to manually assign
  // Replace with algorithm in Phase 3

  const order = await db.query(
    `SELECT o.*, c.phone as client_phone
     FROM orders o JOIN clients c ON o.client_id = c.id
     WHERE o.id = $1`,
    [orderId]
  );
  const o = order.rows[0];

  const adminPhone = process.env.ADMIN_PHONE!;
  await sendWhatsApp(adminPhone,
    `🔔 *Order Baru #${o.id}*\n\n` +
    `Unit: ${o.units} AC\n` +
    `Harga: Rp ${parseInt(o.price).toLocaleString('id-ID')}\n` +
    `Jadwal: ${o.scheduled_at}\n\n` +
    `Assign teknisi: kirim "assign ${o.id} [nomor HP teknisi]"`
  );
}

export async function assignWorker(orderId: number, workerPhone: string) {
  const worker = await db.query('SELECT * FROM workers WHERE phone = $1', [workerPhone]);
  if (!worker.rows.length) return;

  const w = worker.rows[0];
  const order = await db.query(
    `UPDATE orders SET worker_id = $1, status = 'assigned' WHERE id = $2 RETURNING *`,
    [w.id, orderId]
  );
  const o = order.rows[0];

  await sendWhatsApp(workerPhone,
    `🔧 *Ada Order Baru!*\n\n` +
    `Order #${o.id}\n` +
    `Unit AC: ${o.units}\n` +
    `Harga kamu: Rp ${Math.floor(o.price * 0.87).toLocaleString('id-ID')}\n\n` +
    `Balas *1* untuk terima, *2* untuk tolak.`
  );
}
```

---

## Step 11 — Before/After Photo Upload (Day 10)

```typescript
// src/services/photo.ts
import cloudinary from 'cloudinary';
import { db } from '../db';
import { getState, setState } from './conversation';
import { sendWhatsApp } from '../utils/whatsapp';

cloudinary.v2.config({ cloud_url: process.env.CLOUDINARY_URL });

export async function handlePhotoUpload(workerPhone: string, mediaUrl: string) {
  const state = await getState(workerPhone);
  const orderId = state.data?.orderId;
  if (!orderId) return;

  const worker = await db.query('SELECT id FROM workers WHERE phone = $1', [workerPhone]);
  const workerId = worker.rows[0].id;

  // Determine photo type based on order status
  const order = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  const photoType = order.rows[0].status === 'in_progress' ? 'after' : 'before';

  // Upload to Cloudinary
  const result = await cloudinary.v2.uploader.upload(mediaUrl, {
    folder: `orders/${orderId}`,
    public_id: `${photoType}_${Date.now()}`,
  });

  await db.query(
    'INSERT INTO photos (order_id, worker_id, type, url) VALUES ($1, $2, $3, $4)',
    [orderId, workerId, photoType, result.secure_url]
  );

  if (photoType === 'before') {
    await db.query(`UPDATE orders SET status = 'in_progress' WHERE id = $1`, [orderId]);
    await sendWhatsApp(workerPhone,
      '✅ Foto sebelum tersimpan. Mulai kerjakan ya!\nSetelah selesai, kirim foto sesudah.'
    );
  } else {
    await sendWhatsApp(workerPhone,
      '✅ Foto sesudah tersimpan.\nSekarang minta kode 4 digit dari klien dan kirim ke sini.'
    );
    await setState(workerPhone, { step: 'await_otp', data: { orderId } });
  }
}
```

---

## Step 12 — WhatsApp Send Helper

```typescript
// src/utils/whatsapp.ts
import axios from 'axios';

export async function sendWhatsApp(phone: string, message: string) {
  await axios.post(
    `${process.env.WATI_API_URL}/api/v1/sendSessionMessage/${phone}`,
    { messageText: message },
    { headers: { Authorization: `Bearer ${process.env.WATI_ACCESS_TOKEN}` } }
  );
}
```

---

## Step 13 — Xendit Payment Webhook

```typescript
// src/routes/xendit.ts
import { Router } from 'express';
import crypto from 'crypto';
import { handlePaymentConfirmed } from '../services/payment';

const router = Router();

router.post('/webhook/xendit', async (req, res) => {
  // Verify Xendit webhook token
  const token = req.headers['x-callback-token'];
  if (token !== process.env.XENDIT_WEBHOOK_TOKEN) {
    return res.sendStatus(403);
  }

  const { status, external_id, id } = req.body;
  if (status === 'PAID') {
    await handlePaymentConfirmed(id, external_id);
  }

  res.sendStatus(200);
});

export default router;
```

---

## Step 14 — Main Server Entry

```typescript
// src/index.ts
import express from 'express';
import 'dotenv/config';
import webhookRouter from './routes/webhook';
import xenditRouter from './routes/xendit';

const app = express();
app.use(express.json());

app.use(webhookRouter);
app.use(xenditRouter);

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
```

---

## Step 15 — Deploy to Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and init
railway login
railway init

# Add PostgreSQL plugin in Railway dashboard
# Copy DATABASE_URL to your .env

# Deploy
railway up
```

Set all `.env` variables in Railway's dashboard under "Variables".

Xendit webhook URL → `https://your-app.railway.app/webhook/xendit`
Wati.io webhook URL → `https://your-app.railway.app/webhook/whatsapp`

---

## Build Order (Day by Day)

| Day | Task | Done When |
|---|---|---|
| 1 | Register all accounts, init project, .env setup | Server starts locally |
| 2 | Database schema live on Railway PostgreSQL | Tables created, connection works |
| 3 | WhatsApp webhook receiving messages | Console logs show incoming messages |
| 4 | Intent detection via Claude API | "cuci AC" returns `order.new` |
| 5 | Conversation state (Redis) + order flow | Bot asks units → location → time |
| 6 | Order created in DB + payment link sent | Order row visible in DB |
| 7 | Xendit webhook + OTP generation | OTP sent to client after payment |
| 8 | Worker notification to admin | Admin receives WhatsApp on new order |
| 9 | Worker accept/reject + manual assign command | Worker gets job offer |
| 10 | Photo upload (before/after) via Cloudinary | Photos stored in DB with URLs |
| 11 | OTP verification + escrow release | Worker submits OTP, order marked done |
| 12 | Rating flow + worker daily summary | Client rates, summary sent at 9PM |
| 13 | End-to-end test: full order cycle | One complete order without manual intervention |
| 14 | Deploy to Railway + connect real Wati + Xendit sandbox | Live URL working |

---

## First Real Order Checklist

- [ ] Wati.io on a real Indonesian phone number
- [ ] Xendit in live mode (not sandbox)
- [ ] At least 1 worker registered in the DB manually
- [ ] Test full flow yourself as both client and worker on 2 phones
- [ ] Admin phone set in `.env` to receive order notifications

---

*Implementation Guide v1.0 — April 2026*
