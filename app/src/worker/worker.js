import { Telegraf } from "telegraf";
import { pool } from "../lib/db.js";

const bot = new Telegraf(process.env.BOT_TOKEN);
const EXPIRE_MIN = Number(process.env.QRIS_EXPIRE_MINUTES || "11");

async function tickOrders() {
  // expire orders
  const exp = await pool.query(
    `select order_code, qris_chat_id, qris_message_id, user_id
     from orders
     where status='PENDING_PAYMENT' and internal_expired_at < now()`
  );
  for (const o of exp.rows) {
    await pool.query(`update orders set status='EXPIRED' where order_code=$1`, [o.order_code]);
    if (o.qris_chat_id && o.qris_message_id) {
      try { await bot.telegram.deleteMessage(o.qris_chat_id, o.qris_message_id); } catch {}
      try { await bot.telegram.sendMessage(o.qris_chat_id, `⏰ Pembayaran *EXPIRED* untuk order \`${o.order_code}\`.\nSilakan buat pembayaran ulang.`, { parse_mode:"Markdown" }); } catch {}
    }
  }

  // expire topups
  const expT = await pool.query(
    `select topup_code, qris_chat_id, qris_message_id
     from topups
     where status='PENDING' and internal_expired_at < now()`
  );
  for (const t of expT.rows) {
    await pool.query(`update topups set status='EXPIRED' where topup_code=$1`, [t.topup_code]);
    if (t.qris_chat_id && t.qris_message_id) {
      try { await bot.telegram.deleteMessage(t.qris_chat_id, t.qris_message_id); } catch {}
      try { await bot.telegram.sendMessage(t.qris_chat_id, `⏰ QRIS Top Up *EXPIRED* (\`${t.topup_code}\`).\nSilakan buat top up ulang.`, { parse_mode:"Markdown" }); } catch {}
    }
  }
}

console.log("Worker started");
setInterval(tickOrders, 30_000);
