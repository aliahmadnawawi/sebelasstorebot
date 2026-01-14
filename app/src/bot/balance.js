import { Markup } from "telegraf";
import { pool, getOrCreateUser } from "../lib/db.js";
import { MIN_TOPUP, MAX_TOPUP } from "./config.js";
import { getLock, setUserState } from "./state.js";
import { uiEdit, clearWarn } from "./ui.js";
import { rupiah, fullNameFromCtx, formatExpireIndo } from "./helpers.js";

export function registerBalance(bot) {
  bot.action("BALANCE", async (ctx) => {
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const lock = getLock(ctx.from.id);
    if (lock) return;

    const u = await getOrCreateUser(ctx.from.id);
    setUserState(ctx.from.id, { page: "BALANCE" });

    const text = `💳 *Informasi Saldo*

👤 Nama: *${fullNameFromCtx(ctx) || "-"}*
🆔 Telegram ID: \`${ctx.from.id}\`
💰 Saldo: *Rp ${rupiah(u.balance || 0)}*\n\n` +
  `Silakan top up untuk menambah saldo!`;

    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("💳 Top Up Saldo", "TOPUP_START")],
      [Markup.button.callback("« Kembali", "MAIN_MENU")],
    ]);
    await uiEdit(ctx, text, kb);
  });

  bot.action("TOPUP_START", async (ctx) => {
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const lock = getLock(ctx.from.id);
    if (lock) return;

    const u = await getOrCreateUser(ctx.from.id);

    const pend = await pool.query(
      `select topup_code, internal_expired_at
       from topups
       where user_id=$1 and status='PENDING' and internal_expired_at > now()
       order by id desc limit 1`,
      [u.id]
    );

    if (pend.rowCount > 0) {
      const code = pend.rows[0].topup_code;
      const exp = new Date(pend.rows[0].internal_expired_at);
      const text = `⚠️ Kamu masih punya Top Up yang belum selesai.

Kode: \`${code}\`
Batas waktu: ${formatExpireIndo(exp)}

Silakan lunasi pembayaran atau tunggu sampai EXPIRED. Setelah itu baru bisa lanjut.`;
      setUserState(ctx.from.id, { page: "BALANCE" });
      return uiEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "BALANCE")]]));
    }

    setUserState(ctx.from.id, { page: "TOPUP_INPUT" });

    const text = `Silakan ketik *jumlah top up* (angka saja).
Minimal *Rp ${rupiah(MIN_TOPUP)}*
Maksimal *Rp ${rupiah(MAX_TOPUP)}*

Contoh: \`${MIN_TOPUP}\``;

    const kb = Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "BALANCE")]]);
    await uiEdit(ctx, text, kb);
  });
}
