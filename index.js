require('dotenv').config({ path: __dirname + '/.env' });
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const { Invoice } = require('xendit-node');

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const xenditInvoice = new Invoice({ secretKey: process.env.XENDIT_SECRET_KEY });

const app = express();
app.use(express.json());

const PRICE_PER_UNIT = 40000;
const WORKER_PHONE = process.env.WORKER_PHONE; // e.g. 6281289922852

const sessions = {};

function generateOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// ─── Meta webhook verification ───────────────────────────────────────────────
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook verified!');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── Incoming WhatsApp messages ──────────────────────────────────────────────
app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200); // always ACK Meta first

  const entry = req.body?.entry?.[0];
  const change = entry?.changes?.[0];
  const messageObj = change?.value?.messages?.[0];

  if (!messageObj || messageObj.type !== 'text') return;

  const phone = messageObj.from; // e.g. 6281289922852
  const message = messageObj.text.body.trim();
  const text = message.toLowerCase();

  console.log(`Message from ${phone}: ${message}`);

  // ── Worker messages ──────────────────────────────────────────────────────
  if (phone === WORKER_PHONE) {
    if (text === '1') {
      const result = await db.query(
        `SELECT * FROM orders WHERE worker_phone = $1 AND status = 'assigned' ORDER BY created_at DESC LIMIT 1`,
        [WORKER_PHONE]
      );
      const order = result.rows[0];
      if (!order) {
        await sendWhatsApp(phone, 'Tidak ada order yang perlu dikonfirmasi.');
        return;
      }
      await db.query(`UPDATE orders SET status = 'in_progress' WHERE id = $1`, [order.id]);
      await sendWhatsApp(phone,
        `✅ Order #${order.id} diterima!\n\n` +
        `📍 Alamat: ${order.address}\n` +
        `🗓️ Jadwal: ${order.schedule}\n\n` +
        `Setelah selesai, minta kode 4 digit dari pelanggan dan kirim ke sini.`
      );
      await sendWhatsApp(order.client_phone,
        `🔧 *Teknisi dalam perjalanan!*\n\nOrder #${order.id} sudah diterima teknisi.\nJadwal: ${order.schedule}\n\nKode konfirmasi kamu: *${order.otp_code}*\nBerikan kode ini ke teknisi SETELAH pekerjaan selesai.`
      );
      return;
    }

    if (text === '2') {
      await db.query(
        `UPDATE orders SET status = 'paid', worker_phone = NULL WHERE worker_phone = $1 AND status = 'assigned'`,
        [WORKER_PHONE]
      );
      await sendWhatsApp(phone, 'Order ditolak. Admin akan assign ulang.');
      return;
    }

    if (/^\d{4}$/.test(text)) {
      const result = await db.query(
        `SELECT * FROM orders WHERE worker_phone = $1 AND otp_code = $2 AND status = 'in_progress' AND otp_expires_at > NOW()`,
        [WORKER_PHONE, text]
      );
      const order = result.rows[0];
      if (!order) {
        await sendWhatsApp(phone, '❌ Kode salah atau sudah kadaluarsa.');
        return;
      }
      await db.query(`UPDATE orders SET status = 'completed', completed_at = NOW() WHERE id = $1`, [order.id]);
      await sendWhatsApp(phone,
        `✅ Order #${order.id} selesai!\nPendapatan: Rp ${Math.floor(order.total * 0.87).toLocaleString('id-ID')}\nAkan ditransfer dalam 1x24 jam.`
      );
      sessions[order.client_phone] = { step: 'waiting_rating', orderId: order.id };
      await sendWhatsApp(order.client_phone,
        `🎉 AC kamu sudah bersih!\n\nBagaimana pelayanan teknisi kami?\nBalas dengan angka *1–5*\n\n5 = Sangat puas\n1 = Tidak puas`
      );
      return;
    }

    await sendWhatsApp(phone, 'Balas *1* untuk terima order, *2* untuk tolak, atau kirim kode 4 digit dari pelanggan.');
    return;
  }

  // ── Customer messages ────────────────────────────────────────────────────
  if (!sessions[phone]) sessions[phone] = { step: 'idle' };
  const session = sessions[phone];

  let reply;

  if (session.step === 'waiting_rating') {
    const score = parseInt(text);
    if (isNaN(score) || score < 1 || score > 5) {
      reply = 'Balas dengan angka 1 sampai 5 ya.';
    } else {
      await db.query(`UPDATE orders SET rating = $1 WHERE id = $2`, [score, session.orderId]);
      sessions[phone] = { step: 'idle' };
      reply = `⭐ Terima kasih atas rating *${score}/5*!\nSampai jumpa di layanan berikutnya. 🙏`;
    }
    await sendWhatsApp(phone, reply);
    return;
  }

  if (text === 'cuci ac' || text === 'pesan') {
    session.step = 'waiting_units';
    reply = 'Halo! Selamat datang di AirBersih 🌬️\n\nBerapa unit AC yang mau dicuci? Ketik angkanya (contoh: 2)';

  } else if (session.step === 'waiting_units') {
    const units = parseInt(text);
    if (isNaN(units) || units < 1) {
      reply = 'Ketik angka ya, contoh: 2';
    } else {
      session.units = units;
      session.step = 'waiting_address';
      reply = `Siap, ${units} unit AC! Sekarang ketik alamat lengkap kamu ya.`;
    }

  } else if (session.step === 'waiting_address') {
    session.address = message;
    session.step = 'waiting_schedule';
    reply = `Alamat dicatat! 📍\n\nKapan mau dijadwalkan?\nKetik tanggal dan jam.\nContoh: *29/04/25 jam 10:00*`;

  } else if (session.step === 'waiting_schedule') {
    const scheduleRegex = /^(\d{2})\/(\d{2})\/(\d{2})\s+jam\s+(\d{1,2}):(\d{2})$/i;
    const match = message.match(scheduleRegex);
    if (!match) {
      await sendWhatsApp(phone, `Format tanggal salah. Ketik seperti contoh ini:\n*29/04/25 jam 10:00*`);
      return;
    }
    const [, day, month, year, hour, minute] = match;
    const parsedDate = new Date(`20${year}-${month}-${day}T${hour.padStart(2,'0')}:${minute}:00`);
    if (isNaN(parsedDate.getTime()) || parsedDate < new Date()) {
      await sendWhatsApp(phone, `Tanggal tidak valid atau sudah lewat. Coba lagi:\nContoh: *29/04/25 jam 10:00*`);
      return;
    }
    session.schedule = `${day}/${month}/${year} jam ${hour.padStart(2,'0')}:${minute}`;
    session.scheduledAt = parsedDate.toISOString();
    session.total = session.units * PRICE_PER_UNIT;
    session.step = 'waiting_confirm';
    reply = `📋 *Ringkasan Pesanan*\n\n` +
            `🔧 Layanan: Cuci AC\n` +
            `📦 Unit: ${session.units} unit\n` +
            `📍 Alamat: ${session.address}\n` +
            `🗓️ Jadwal: ${session.schedule}\n` +
            `💰 Total: *Rp ${session.total.toLocaleString('id-ID')}*\n\n` +
            `Balas *YA* untuk konfirmasi, atau *BATAL* untuk membatalkan.`;

  } else if (session.step === 'waiting_confirm') {
    if (text === 'ya') {
      const result = await db.query(
        `INSERT INTO orders (client_phone, units, address, schedule, total, scheduled_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending_payment') RETURNING id`,
        [phone, session.units, session.address, session.schedule, session.total, session.scheduledAt]
      );
      const orderId = result.rows[0].id;

      const invoice = await xenditInvoice.createInvoice({
        data: {
          externalId: `order-${orderId}`,
          amount: session.total,
          description: `AirBersih - Cuci AC ${session.units} unit`,
          invoiceDuration: 3600,
          currency: 'IDR',
        }
      });

      reply = `✅ *Pesanan dikonfirmasi!*\n\n` +
              `Total: *Rp ${session.total.toLocaleString('id-ID')}*\n\n` +
              `Silakan bayar via link berikut:\n${invoice.invoiceUrl}\n\n` +
              `Link berlaku 1 jam. Setelah bayar, teknisi akan segera dihubungi. 🙏`;
    } else {
      reply = `Pesanan dibatalkan. Ketik *cuci AC* kalau mau pesan lagi ya! 😊`;
    }
    sessions[phone] = { step: 'idle' };

  } else {
    session.step = 'idle';
    reply = 'Halo! Ini AirBersih 🌬️\n\nKetik *cuci AC* untuk mulai pesan.';
  }

  await sendWhatsApp(phone, reply);
});

// ─── Xendit payment webhook ──────────────────────────────────────────────────
app.post('/webhook/xendit', async (req, res) => {
  const token = req.headers['x-callback-token'];
  if (token !== process.env.XENDIT_WEBHOOK_TOKEN) return res.sendStatus(403);

  const { status, external_id } = req.body;
  if (status !== 'PAID') return res.sendStatus(200);
  if (!external_id?.startsWith('order-')) return res.sendStatus(200);

  const orderId = parseInt(external_id.replace('order-', ''));
  if (isNaN(orderId)) return res.sendStatus(200);

  const otp = generateOTP();
  const otpExpiry = new Date(Date.now() + 6 * 60 * 60 * 1000);

  const result = await db.query(
    `UPDATE orders SET status = 'assigned', otp_code = $1, otp_expires_at = $2, worker_phone = $3
     WHERE id = $4 RETURNING *`,
    [otp, otpExpiry, WORKER_PHONE, orderId]
  );

  const order = result.rows[0];
  if (!order) return res.sendStatus(200);

  await sendWhatsApp(order.client_phone,
    `🎉 *Pembayaran diterima!*\n\nOrder #${orderId} dikonfirmasi.\n\nKode konfirmasi: *${otp}*\nBerikan kode ini ke teknisi SETELAH AC selesai dibersihkan.`
  );

  await sendWhatsApp(WORKER_PHONE,
    `🔔 *Ada Order Baru! #${orderId}*\n\n` +
    `📦 Unit: ${order.units} AC\n` +
    `📍 Alamat: ${order.address}\n` +
    `🗓️ Jadwal: ${order.schedule}\n` +
    `💰 Kamu dapat: Rp ${Math.floor(order.total * 0.87).toLocaleString('id-ID')}\n\n` +
    `Balas *1* untuk terima, *2* untuk tolak.`
  );

  res.sendStatus(200);
});

// ─── Send WhatsApp via Meta Cloud API ───────────────────────────────────────
async function sendWhatsApp(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.META_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error(`Failed to send to ${to}:`, err.response?.data || err.message);
  }
}

app.listen(process.env.PORT || 3000, () => {
  console.log('Server is running on port', process.env.PORT || 3000);
});
