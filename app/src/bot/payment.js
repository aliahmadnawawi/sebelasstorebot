import { Markup } from "telegraf";
import { pool, getOrCreateUser } from "../lib/db.js";
import { makeOrderCode } from "../lib/id.js";
import { pakasirCreateQris, pakasirDetail } from "../lib/pakasir.js";
import { qrisToPngBuffer } from "../lib/qris.js";

import { EXPIRE_MIN, ADMIN_CONTACT_URL, PAKASIR_PROJECT, PAKASIR_API_KEY } from "./config.js";
import {
  rupiah,
  formatExpireIndo,
  isPaidFromDetail,
  productTitleFromName,
  productCategoryFromName,
  nowMs,
} from "./helpers.js";

import {
  getLock,
  setLock,
  clearLock,
  setUserState,
  clearUserState,
  checkCooldownUntil,
} from "./state.js";

import {
  safeDelete,
  replaceEphemeral,
  cleanupCodeAll,
  rememberQris,
  rememberTimer,
  uiNew,
  uiEdit,
  clearWarn,
} from "./ui.js";

import { sendMainMenu } from "./menu.js";

// ========= unique =========
function pickUniqueCode99() {
  return Math.floor(Math.random() * 99) + 1;
}

async function pickUniqueForBaseAmount(baseAmount) {
  for (let i = 0; i < 180; i++) {
    const unique = pickUniqueCode99();
    const total = baseAmount + unique;

    const q = await pool.query(
      `
      select 1 from orders
        where status='PENDING_PAYMENT'
          and internal_expired_at > now()
          and total_amount = $1
      union all
      select 1 from topups
        where status='PENDING'
          and internal_expired_at > now()
          and total_amount = $1
      limit 1
      `,
      [total]
    );

    if (q.rowCount === 0) return { unique, total };
  }
  const unique = pickUniqueCode99();
  return { unique, total: baseAmount + unique };
}

// ========= Placeholder 1x1 PNG (safe) =========
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ax0q5kAAAAASUVORK5CYII=",
  "base64"
);

async function createInvoicePlaceholder(ctx, caption) {
  const sent = await uiEdit(ctx, caption);
  return sent;
}

async function editInvoiceToQris(ctx, chatId, msgId, pngBuffer, captionText, keyboard, code) {
  // Hapus pesan "loading..." (teks) kalau bisa
  try {
    await safeDelete(ctx, chatId, msgId);
  } catch {}

  // Kirim foto QRIS baru
  const sent = await ctx.replyWithPhoto(
    { source: pngBuffer, filename: "qris.png" },
    { caption: captionText, parse_mode: "Markdown", ...(keyboard ? keyboard : {}) }
  );

  // IMPORTANT: update mapping supaya cleanup/expired bisa delete yg benar
  if (code) rememberQris(code, sent.chat.id, sent.message_id);

  return sent;
}

// ========= schedule expired flow =========
function scheduleExpiredFlow(ctx, code, expiredAt) {
  const msLeft = expiredAt.getTime() - Date.now();
  if (msLeft <= 0) return;

  const tWarn = setTimeout(async () => {
    await replaceEphemeral(ctx, code, "🚨 Pembayaran Anda telah expired.", 30_000);
  }, Math.max(0, msLeft - 10_000));
  rememberTimer(code, tWarn);

  const tExpire = setTimeout(async () => {
    if (String(code).startsWith("TOPUP-")) {
      await pool.query(`update topups set status='EXPIRED' where topup_code=$1 and status='PENDING'`, [code]).catch(() => {});
    } else {
      await pool.query(`update orders set status='EXPIRED' where order_code=$1 and status='PENDING_PAYMENT'`, [code]).catch(() => {});
    }

    await cleanupCodeAll(ctx, code);

    const l = getLock(ctx.from.id);
    if (l && l.code === code) clearLock(ctx.from.id);

    clearUserState(ctx.from.id);
    await clearWarn(ctx);
    setUserState(ctx.from.id, { page: "MENU" });
    await sendMainMenu(ctx, "new");
  }, msLeft);
  rememberTimer(code, tExpire);
}

// ================== STOCK CONSUME (INVITE/AUTO/LICENSE) ==================
async function consumeOneStockSlot(productId, orderCode) {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const s = await client.query(
      `select id
       from license_stock
       where product_id=$1 and is_used=false
       order by id asc
       for update skip locked
       limit 1`,
      [productId]
    );

    if (s.rowCount === 0) {
      await client.query("rollback");
      return false;
    }

    const stockId = s.rows[0].id;
    await client.query(
      `update license_stock
       set is_used=true, used_at=now(), used_by_order_id=$1
       where id=$2`,
      [orderCode, stockId]
    );

    await client.query("commit");
    return true;
  } catch (e) {
    await client.query("rollback");
    console.error("consumeOneStockSlot error:", e);
    return false;
  } finally {
    client.release();
  }
}

async function getInviteSlotsLeft(productId) {
  const q = await pool.query(
    `select count(*)::int as left
     from license_stock
     where product_id=$1 and is_used=false`,
    [productId]
  );
  return Number(q.rows[0]?.left || 0);
}

// ================== pending checks ==================
async function ensureNoPendingOrderForUser(userId) {
  const q = await pool.query(
    `select order_code from orders
     where user_id=$1 and status='PENDING_PAYMENT' and internal_expired_at > now()
     order by id desc limit 1`,
    [userId]
  );
  return q.rows[0]?.order_code || null;
}

async function ensureNoPendingTopupForUser(userId) {
  const q = await pool.query(
    `select topup_code from topups
     where user_id=$1 and status='PENDING' and internal_expired_at > now()
     order by id desc limit 1`,
    [userId]
  );
  return q.rows[0]?.topup_code || null;
}

// ================== create order/topup invoice ==================
async function createQrisOrder(ctx, product) {
  const user = await getOrCreateUser(ctx.from.id);

  const pendingOrder = await ensureNoPendingOrderForUser(user.id);
  if (pendingOrder) {
    const r = await pool.query(`select internal_expired_at from orders where order_code=$1`, [pendingOrder]);
    const exp = r.rows[0]?.internal_expired_at ? new Date(r.rows[0].internal_expired_at) : null;

    const text = `⚠️ Kamu masih punya pembayaran yang belum selesai.

Kode: \`${pendingOrder}\`${exp ? `\nBatas waktu: ${formatExpireIndo(exp)}` : ""}

Silakan lunasi pembayaran atau tunggu sampai EXPIRED.`;
    return uiEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback("🏡 Menu", "MAIN_MENU")]]));
  }

  const left = await getInviteSlotsLeft(product.id);
  if (left <= 0) {
    const m = await ctx.reply("⚠️ Stok produk ini habis. Silakan pilih produk lain.");
    setTimeout(() => safeDelete(ctx, m.chat.id, m.message_id), 2000);
    return;
  }

  const baseAmount = Number(product.price || 0);
  const { unique, total } = await pickUniqueForBaseAmount(baseAmount);

  const orderCode = makeOrderCode();
  const now = new Date();
  const internalExpired = new Date(now.getTime() + EXPIRE_MIN * 60 * 1000);

  await pool.query(
    `insert into orders
      (order_code,user_id,product_id,amount,base_amount,unique_code,total_amount,pay_method,status,internal_expired_at)
     values ($1,$2,$3,$4,$5,$6,$4,'QRIS','PENDING_PAYMENT',$7)`,
    [orderCode, user.id, product.id, total, baseAmount, unique, internalExpired.toISOString()]
  );

  setLock(ctx.from.id, { kind: "ORDER", code: orderCode, expiredAt: internalExpired });

  const kbCheck = Markup.inlineKeyboard([[Markup.button.callback("🔄 Cek Status", `CHECK:${orderCode}`)]]);
  const sent = await createInvoicePlaceholder(ctx, "⏳ Membuat invoice pembayaran...");
  rememberQris(orderCode, sent.chat.id, sent.message_id);

  const t = setTimeout(async () => {
    try {
      const pay = await pakasirCreateQris({
        project: PAKASIR_PROJECT,
        apiKey: PAKASIR_API_KEY,
        orderId: orderCode,
        amount: total,
      });

      const qrString = pay.payment_number || pay.qr_string || pay.qr || pay.paymentNumber;
      if (!qrString) {
        await replaceEphemeral(ctx, orderCode, "⚠️ Gagal membuat QRIS (QR string tidak ditemukan).", 5000);
        clearLock(ctx.from.id);
        await cleanupCodeAll(ctx, orderCode);
        return;
      }

      const png = await qrisToPngBuffer(qrString);

      const caption =
        `💳 *QRIS Pembayaran*\n\n` +
        `Order: \`${orderCode}\`\n` +
        `Nominal: Rp ${rupiah(baseAmount)}\n` +
        `Kode unik: ${unique}\n` +
        `Total bayar: Rp ${rupiah(total)}\n` +
        `Berlaku sampai: ${formatExpireIndo(internalExpired)}`;

      await editInvoiceToQris(ctx, sent.chat.id, sent.message_id, png, caption, kbCheck, orderCode);
      scheduleExpiredFlow(ctx, orderCode, internalExpired);
    } catch (e) {
      console.error("createQrisOrder error:", e);
      await replaceEphemeral(ctx, orderCode, "⚠️ Gagal membuat invoice. Coba lagi.", 5000);
      clearLock(ctx.from.id);
      await cleanupCodeAll(ctx, orderCode);
    }
  }, 3000);
  rememberTimer(orderCode, t);
}

export async function createTopupInvoice(ctx, baseAmount, userMsgToDelete) {
  const u = await getOrCreateUser(ctx.from.id);

  const pendingTopup = await ensureNoPendingTopupForUser(u.id);
  if (pendingTopup) {
    const r = await pool.query(`select internal_expired_at from topups where topup_code=$1`, [pendingTopup]);
    const exp = r.rows[0]?.internal_expired_at ? new Date(r.rows[0].internal_expired_at) : null;

    const text = `⚠️ Kamu masih punya Top Up yang belum selesai.

Kode: \`${pendingTopup}\`${exp ? `\nBatas waktu: ${formatExpireIndo(exp)}` : ""}

Silakan lunasi pembayaran atau tunggu sampai EXPIRED.`;
    return uiEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback("🏡 Menu", "MAIN_MENU")]]));
  }

  const { unique, total } = await pickUniqueForBaseAmount(baseAmount);

  const topupCode = makeOrderCode().replace("SSB-", "TOPUP-");
  const now = new Date();
  const internalExpired = new Date(now.getTime() + EXPIRE_MIN * 60 * 1000);

  await pool.query(
    `insert into topups (topup_code,user_id,base_amount,unique_code,total_amount,status,internal_expired_at)
     values ($1,$2,$3,$4,$5,'PENDING',$6)`,
    [topupCode, u.id, baseAmount, unique, total, internalExpired.toISOString()]
  );

  setLock(ctx.from.id, { kind: "TOPUP", code: topupCode, expiredAt: internalExpired });

  const kbCheck = Markup.inlineKeyboard([[Markup.button.callback("🔄 Cek Status", `CHECKTOPUP:${topupCode}`)]]);
  const sent = await createInvoicePlaceholder(ctx, "⏳ Membuat invoice top up...");
  rememberQris(topupCode, sent.chat.id, sent.message_id);

  const t = setTimeout(async () => {
    try {
      const pay = await pakasirCreateQris({
        project: PAKASIR_PROJECT,
        apiKey: PAKASIR_API_KEY,
        orderId: topupCode,
        amount: total,
      });

      const qrString = pay.payment_number || pay.qr_string || pay.qr || pay.paymentNumber;
      if (!qrString) {
        await replaceEphemeral(ctx, topupCode, "⚠️ Gagal membuat QRIS top up (QR string tidak ditemukan).", 5000);
        clearLock(ctx.from.id);
        await cleanupCodeAll(ctx, topupCode);
        return;
      }

      const png = await qrisToPngBuffer(qrString);

      const caption =
        `💳 *QRIS Top Up*\n\n` +
        `Kode: \`${topupCode}\`\n` +
        `Nominal: Rp ${rupiah(baseAmount)}\n` +
        `Kode unik: ${unique}\n` +
        `Total bayar: Rp ${rupiah(total)}\n` +
        `Berlaku sampai: ${formatExpireIndo(internalExpired)}`;

      await editInvoiceToQris(ctx, sent.chat.id, sent.message_id, png, caption, kbCheck, topupCode);
      scheduleExpiredFlow(ctx, topupCode, internalExpired);

      if (userMsgToDelete?.chatId && userMsgToDelete?.msgId) {
        await safeDelete(ctx, userMsgToDelete.chatId, userMsgToDelete.msgId);
      }
    } catch (e) {
      console.error("createTopupInvoice error:", e);
      await replaceEphemeral(ctx, topupCode, "⚠️ Gagal membuat invoice top up. Coba lagi.", 5000);
      clearLock(ctx.from.id);
      await cleanupCodeAll(ctx, topupCode);
    }
  }, 3000);
  rememberTimer(topupCode, t);
}

// ================== SUCCESS HANDLERS ==================
async function onPaymentSuccess(ctx, orderCode) {
  await cleanupCodeAll(ctx, orderCode);

  const l = getLock(ctx.from.id);
  if (l && l.code === orderCode) clearLock(ctx.from.id);

  const r = await pool.query(
    `select o.*, p.type as product_type, p.name as product_name, p.id as product_id
     from orders o join products p on p.id=o.product_id
     where o.order_code=$1`,
    [orderCode]
  );
  if (r.rowCount === 0) return;

  const o = r.rows[0];
  const pType = String(o.product_type || "").toUpperCase();
  const title = productTitleFromName(o.product_name);

  if (pType === "INVITE" || pType === "AUTO" || pType === "LICENSE") {
    const ok = await consumeOneStockSlot(Number(o.product_id), orderCode);
    if (!ok) {
      setUserState(ctx.from.id, { page: "MENU" });
      const kb = Markup.inlineKeyboard([
        [Markup.button.url("💬 Chat Admin", ADMIN_CONTACT_URL)],
        [Markup.button.callback("🏡 Menu", "MAIN_MENU")],
      ]);
      return uiNew(ctx, `✅ Pembayaran berhasil!\nProduk: *${title}*\n\n⚠️ Stok slot habis saat proses. Silakan chat admin.`, kb);
    }
  }

  if (pType === "INVITE") {
    setUserState(ctx.from.id, { page: "MENU" });
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("💬 Hubungi Admin", `INVITE_ADMIN:${orderCode}`)],
      [Markup.button.callback("🏡 Menu", "MAIN_MENU")],
    ]);
    return uiNew(ctx, `✅ Pembayaran berhasil!\nProduk: *${title}*`, kb);
  }

  if (pType === "AUTO" || pType === "LICENSE") {
    setUserState(ctx.from.id, { page: "MENU" });
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("📦 Ambil Produk", `GETPROD:${orderCode}`)],
      [Markup.button.callback("🏡 Menu", "MAIN_MENU")],
    ]);
    return uiNew(ctx, `✅ Pembayaran berhasil!\nProduk: *${title}*`, kb);
  }

  setUserState(ctx.from.id, { page: "MENU" });
  return uiNew(ctx, `✅ Pembayaran berhasil!\nProduk: *${title}*`, Markup.inlineKeyboard([[Markup.button.callback("🏡 Menu", "MAIN_MENU")]]));
}

async function onTopupSuccess(ctx, topupCode, baseAmount) {
  await cleanupCodeAll(ctx, topupCode);

  const l = getLock(ctx.from.id);
  if (l && l.code === topupCode) clearLock(ctx.from.id);

  const text = `✅ Top up berhasil!

Kode: \`${topupCode}\`
Saldo bertambah: *Rp ${rupiah(baseAmount)}*`;

  const kb = Markup.inlineKeyboard([[Markup.button.callback("🏡 Menu", "MAIN_MENU"), Markup.button.callback("💳 Lihat Saldo", "BALANCE")]]);
  setUserState(ctx.from.id, { page: "MENU" });
  await uiNew(ctx, text, kb);
}

// ================== REGISTER PAYMENT HANDLERS ==================
export function registerPayment(bot) {
  // CHECK ORDER
  bot.action(/^CHECK:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const code = ctx.match[1];

    const until = checkCooldownUntil.get(code) || 0;
    if (nowMs() < until) return;
    checkCooldownUntil.set(code, nowMs() + 5000);

    const r = await pool.query(`select * from orders where order_code=$1`, [code]);
    if (r.rowCount === 0) return;

    const o = r.rows[0];
    if (o.status === "PAID") return onPaymentSuccess(ctx, code);

    if (o.status === "PENDING_PAYMENT" && o.internal_expired_at && new Date(o.internal_expired_at) <= new Date()) {
      await pool.query(`update orders set status='EXPIRED' where order_code=$1 and status='PENDING_PAYMENT'`, [code]).catch(() => {});
      await cleanupCodeAll(ctx, code);
      const l = getLock(ctx.from.id);
      if (l && l.code === code) clearLock(ctx.from.id);
      clearUserState(ctx.from.id);
      setUserState(ctx.from.id, { page: "MENU" });
      await sendMainMenu(ctx, "new");
      return;
    }

    const detail = await pakasirDetail({
      project: PAKASIR_PROJECT,
      apiKey: PAKASIR_API_KEY,
      orderId: code,
      amount: Number(o.total_amount || o.amount),
    });

    const paid = isPaidFromDetail(detail);
    if (!paid) {
      await replaceEphemeral(ctx, code, "⏳ Belum lunas. Jika sudah bayar, tunggu 1-2 menit lalu cek lagi.", 5000);
      return;
    }

    await pool.query(`update orders set status='PAID', paid_at=now() where order_code=$1 and status<>'PAID'`, [code]);
    return onPaymentSuccess(ctx, code);
  });

  // CHECK TOPUP
  bot.action(/^CHECKTOPUP:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const code = ctx.match[1];

    const until = checkCooldownUntil.get(code) || 0;
    if (nowMs() < until) return;
    checkCooldownUntil.set(code, nowMs() + 5000);

    const r = await pool.query(`select * from topups where topup_code=$1`, [code]);
    if (r.rowCount === 0) return;

    const t = r.rows[0];
    if (t.status === "PAID") {
      const kb = Markup.inlineKeyboard([[Markup.button.callback("🏡 Menu", "MAIN_MENU"), Markup.button.callback("💳 Lihat Saldo", "BALANCE")]]);
      setUserState(ctx.from.id, { page: "MENU" });
      return uiNew(ctx, "✅ Top up sudah masuk sebelumnya.", kb);
    }

    if (t.status === "PENDING" && t.internal_expired_at && new Date(t.internal_expired_at) <= new Date()) {
      await pool.query(`update topups set status='EXPIRED' where topup_code=$1 and status='PENDING'`, [code]).catch(() => {});
      await cleanupCodeAll(ctx, code);
      const l = getLock(ctx.from.id);
      if (l && l.code === code) clearLock(ctx.from.id);
      clearUserState(ctx.from.id);
      setUserState(ctx.from.id, { page: "MENU" });
      await sendMainMenu(ctx, "new");
      return;
    }

    const detail = await pakasirDetail({
      project: PAKASIR_PROJECT,
      apiKey: PAKASIR_API_KEY,
      orderId: code,
      amount: Number(t.total_amount),
    });

    const paid = isPaidFromDetail(detail);
    if (!paid) {
      await replaceEphemeral(ctx, code, "⏳ Top up belum lunas. Jika sudah bayar, tunggu 1-2 menit lalu cek lagi.", 5000);
      return;
    }

    const upd = await pool.query(
      `update topups set status='PAID', paid_at=now()
       where topup_code=$1 and status<>'PAID'
       returning base_amount, user_id`,
      [code]
    );

    if (upd.rowCount === 0) {
      const kb = Markup.inlineKeyboard([[Markup.button.callback("🏡 Menu", "MAIN_MENU"), Markup.button.callback("💳 Lihat Saldo", "BALANCE")]]);
      setUserState(ctx.from.id, { page: "MENU" });
      return uiNew(ctx, "✅ Top up sudah masuk sebelumnya.", kb);
    }

    const row = upd.rows[0];
    await pool.query(`update users set balance = balance + $1 where id=$2`, [Number(row.base_amount), row.user_id]);
    return onTopupSuccess(ctx, code, Number(row.base_amount));
  });

  // INVITE ADMIN
  bot.action(/^INVITE_ADMIN:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const code = ctx.match[1];

    await uiNew(
      ctx,
      "📩 Produk ini membutuhkan *invite*.\n\nSilakan chat admin dan kirim email kamu untuk diproses.",
      Markup.inlineKeyboard([
        [Markup.button.url("💬 Chat Admin", ADMIN_CONTACT_URL)],
        [Markup.button.callback("🏡 Menu", "MAIN_MENU")],
      ])
    );

    await pool.query(`update orders set delivered_at=now() where order_code=$1 and delivered_at is null`, [code]).catch(() => {});
  });

  // GET PRODUCT (AUTO/LICENSE)
  bot.action(/^GETPROD:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const orderCode = ctx.match[1];

    const r = await pool.query(
      `select o.*, p.type as product_type, p.name as product_name, p.id as product_id
       from orders o join products p on p.id=o.product_id
       where o.order_code=$1`,
      [orderCode]
    );
    if (r.rowCount === 0) return;

    const o = r.rows[0];
    if (o.status !== "PAID") return;
    if (o.delivered_at) return;

    const pType = String(o.product_type || "").toUpperCase();
    if (!(pType === "AUTO" || pType === "LICENSE")) return;

    const client = await pool.connect();
    try {
      await client.query("begin");

      // take REAL stock (not INVITE_SLOT)
      const s2 = await client.query(
        `select id, code
         from license_stock
         where product_id=$1 and is_used=false and code not like 'INVITE_SLOT_%'
         order by id asc
         for update skip locked
         limit 1`,
        [o.product_id]
      );

      if (s2.rowCount === 0) {
        await client.query("rollback");
        await replaceEphemeral(ctx, orderCode, "⚠️ Stok habis. Hubungi admin.", 5000);
        return;
      }

      const payload = String(s2.rows[0].code || "").trim();

      await client.query(
        `update license_stock
         set is_used=true, used_at=now(), used_by_order_id=$1
         where id=$2`,
        [orderCode, s2.rows[0].id]
      );

      await client.query(`update orders set delivered_at=now() where order_code=$1 and delivered_at is null`, [orderCode]);

      await client.query("commit");

      await ctx.reply(`📦 *Produk Anda*\n\n\`\`\`\n${payload}\n\`\`\`\n\n✅ Harap simpan data ini.`, { parse_mode: "Markdown" });

      const buf = Buffer.from(payload + "\n", "utf-8");
      await ctx.replyWithDocument({ source: buf, filename: `${orderCode}.txt` });
    } catch (e) {
      await client.query("rollback");
      console.error("GETPROD error:", e);
      await replaceEphemeral(ctx, orderCode, "⚠️ Gagal mengambil produk. Coba lagi.", 5000);
    } finally {
      client.release();
    }
  });

   // MY PRODUCTS
bot.action("MY_PRODUCTS", async (ctx) => {
  await ctx.answerCbQuery();
  await clearWarn(ctx);

  const u = await getOrCreateUser(ctx.from.id);

  const fullName =
    [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ").trim() || "-";

  const q = await pool.query(
    `
    select
      o.order_code,
      o.paid_at,
      p.name as product_name,
      p.type as product_type,
      ls.code as payload
    from orders o
    join products p on p.id=o.product_id
    join license_stock ls on ls.used_by_order_id=o.order_code
    where o.user_id=$1
      and o.status='PAID'
      and upper(coalesce(p.type::text,'')) in ('AUTO','LICENSE')
      and ls.code is not null
      and ls.code not like 'INVITE_SLOT_%'
    order by o.paid_at desc nulls last
    limit 20
    `,
    [u.id]
  );

  if (q.rowCount === 0) {
    const text =
      `🖥 *Produk Saya*\n\n` +
      `👤 Nama: ${fullName}\n` +
      `🆔 Telegram ID: ${ctx.from.id}\n\n` +
      `Belum ada produk *AUTO/License* yang bisa ditampilkan.\n` +
      `Beli produk tipe *AUTO/License*, lalu ambil via tombol 📦 Ambil Produk.`;

    const kb = Markup.inlineKeyboard([
  [
    Markup.button.callback("« Kembali", "MAIN_MENU"),
    Markup.button.callback("🛒 Beli Produk", "CATALOG"),
  ],
]);
    return uiEdit(ctx, text, kb);
  }

  // Biar aman dari error Markdown
  const itemsText = q.rows
    .map((r, idx) => {
      const title = productTitleFromName(r.product_name);
      const payload = String(r.payload || "").trim() || "-";

      return (
        `#${idx + 1}\n` +
        `Produk: ${title}\n` +
        `Order: ${r.order_code}\n` +
        `Isi:\n` +
        "```\n" +
        payload +
        "\n```"
      );
    })
    .join("\n\n﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌\n\n");

  const text =
    `🖥 *Produk Saya*\n\n` +
    `👤 Nama: ${fullName}\n` +
    `🆔 Telegram ID: ${ctx.from.id}\n\n` +
    itemsText;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("🏡 Menu", "MAIN_MENU")],
  ]);

  return uiEdit(ctx, text, kb);
});

  // PAY QRIS
  bot.action(/^PAYQRIS:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const lock = getLock(ctx.from.id);
    if (lock) return;

    const productId = Number(ctx.match[1]);
    const pr = await pool.query(`select * from products where id=$1 and is_active=true`, [productId]);
    if (pr.rowCount === 0) return;

    const p = pr.rows[0];

    const left = await getInviteSlotsLeft(p.id);
    if (left <= 0) {
      const m = await ctx.reply("⚠️ Stok produk ini habis. Silakan pilih produk lain.");
      setTimeout(() => safeDelete(ctx, m.chat.id, m.message_id), 2000);
      return;
    }

    await createQrisOrder(ctx, p);
  });

  // PAY SALDO
  bot.action(/^PAYSALDO:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const lock = getLock(ctx.from.id);
    if (lock) return;

    const productId = Number(ctx.match[1]);
    const pr = await pool.query(`select * from products where id=$1 and is_active=true`, [productId]);
    if (pr.rowCount === 0) return;

    const p = pr.rows[0];
    const user = await getOrCreateUser(ctx.from.id);

    const pendingOrder = await ensureNoPendingOrderForUser(user.id);
    if (pendingOrder) {
      return uiEdit(
        ctx,
        "⚠️ Kamu masih punya pembayaran yang belum selesai.\n\nSilakan lunasi atau tunggu expired.",
        Markup.inlineKeyboard([[Markup.button.callback("🏡 Menu", "MAIN_MENU")]])
      );
    }

    const left = await getInviteSlotsLeft(p.id);
    if (left <= 0) {
      const m = await ctx.reply("⚠️ Stok produk ini habis. Silakan pilih produk lain.");
      setTimeout(() => safeDelete(ctx, m.chat.id, m.message_id), 2000);
      return;
    }

    const price = Number(p.price || 0);
    if (Number(user.balance || 0) < price) {
      return uiEdit(
        ctx,
        `⚠️ Saldo tidak cukup.\nHarga: Rp ${rupiah(price)}\nSaldo kamu: Rp ${rupiah(user.balance || 0)}\n\nSilakan top up dulu di menu Saldo.`,
        Markup.inlineKeyboard([[Markup.button.callback("💳 Saldo", "BALANCE"), Markup.button.callback("🏡 Menu", "MAIN_MENU")]])
      );
    }

    const orderCode = makeOrderCode();
    await pool.query(
      `insert into orders
        (order_code,user_id,product_id,amount,base_amount,unique_code,total_amount,pay_method,status,internal_expired_at,paid_at)
       values ($1,$2,$3,$4,$4,0,$4,'BALANCE','PAID', now(), now())`,
      [orderCode, user.id, p.id, price]
    );
    await pool.query(`update users set balance = balance - $1 where id=$2`, [price, user.id]);

    await consumeOneStockSlot(Number(p.id), orderCode);
    return onPaymentSuccess(ctx, orderCode);
  });

  // NOOP
  bot.action("NOOP", async (ctx) => ctx.answerCbQuery());
}
