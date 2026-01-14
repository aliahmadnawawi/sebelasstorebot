import express from "express";
import { Telegraf } from "telegraf";
import { pool } from "../lib/db.js";
import { pakasirDetail } from "../lib/pakasir.js";

const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

const botToken = process.env.BOT_TOKEN;
const bot = botToken ? new Telegraf(botToken) : null;

async function markPaidAndDeliver(orderCode) {
  // ambil order + user + produk
  const r = await pool.query(
    `select o.*, u.telegram_id, p.type, p.file_path, p.name
     from orders o
     join users u on u.id=o.user_id
     join products p on p.id=o.product_id
     where o.order_code=$1`,
    [orderCode]
  );
  if (r.rowCount === 0) return;

  const o = r.rows[0];
  if (o.status === "PAID" && o.delivered_at) return; // idempotent

  // set PAID jika belum
  await pool.query(
    `update orders set status='PAID', paid_at=coalesce(paid_at, now()) where order_code=$1 and status!='PAID'`,
    [orderCode]
  );

  // deliver sekali
  const r2 = await pool.query(`select delivered_at from orders where order_code=$1`, [orderCode]);
  if (r2.rows[0]?.delivered_at) return;

  if (!bot) return;

  await bot.telegram.sendMessage(o.telegram_id, `✅ Pembayaran berhasil!\nProduk: *${o.name}*`, { parse_mode: "Markdown" });

  if (o.type === "FILE") {
    if (!o.file_path) {
      await bot.telegram.sendMessage(o.telegram_id, "⚠️ File produk belum diset admin.");
    } else {
      await bot.telegram.sendDocument(o.telegram_id, { source: o.file_path });
    }
  } else {
    // LICENSE: ambil 1 stock dengan locking
    const client = await pool.connect();
    try {
      await client.query("begin");
      const s = await client.query(
        `select id, code from license_stock
         where product_id=$1 and is_used=false
         order by id asc
         for update skip locked
         limit 1`,
        [o.product_id]
      );
      if (s.rowCount === 0) {
        await bot.telegram.sendMessage(o.telegram_id, "⚠️ Stok lisensi habis. Hubungi admin.");
        await client.query("rollback");
      } else {
        const stock = s.rows[0];
        await client.query(
          `update license_stock set is_used=true, used_at=now(), used_by_order_id=$1 where id=$2`,
          [orderCode, stock.id]
        );
        await client.query(`update orders set delivered_at=now() where order_code=$1`, [orderCode]);
        await client.query("commit");
        await bot.telegram.sendMessage(o.telegram_id, `🔑 Kode Lisensi kamu:\n\`${stock.code}\``, { parse_mode: "Markdown" });
      }
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
    return;
  }

  await pool.query(`update orders set delivered_at=now() where order_code=$1`, [orderCode]);
}

app.post("/webhook/pakasir", async (req, res) => {
  try {
    const { order_id, amount, status } = req.body || {};
    if (!order_id || !amount) return res.status(400).json({ ok: false });

    // validasi pakai transactiondetail (lebih aman)
    const detail = await pakasirDetail({
      project: process.env.PAKASIR_PROJECT,
      apiKey: process.env.PAKASIR_API_KEY,
      orderId: order_id,
      amount
    });

    const isCompleted = JSON.stringify(detail).toLowerCase().includes("completed");
    if (status === "completed" || isCompleted) {
      await markPaidAndDeliver(order_id);
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false });
  }
});

app.listen(3000, () => console.log("API listening on 3000"));
