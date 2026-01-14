import { MIN_TOPUP, MAX_TOPUP } from "./config.js";
import { isAdmin, parseAmountText, formatExpireIndo, rupiah } from "./helpers.js";
import { getLock, getUserState, clearUserState, setUserState } from "./state.js";
import { deleteIncomingUserMessage, replaceEphemeral, safeDelete, clearWarn } from "./ui.js";
import { sendMainMenu } from "./menu.js";
import { createTopupInvoice } from "./payment.js"; // nanti payment.js kita buat

export function registerGuard(bot) {
  bot.use(async (ctx, next) => {
    try {
      // only user text messages (not callback_query)
      if (!ctx.message || typeof ctx.message.text !== "string") return next();
      if (!ctx.from?.id) return next();
      if (isAdmin(ctx)) return next();

      const txt = (ctx.message.text || "").trim();

      const lock = getLock(ctx.from.id);
      if (lock) {
        await deleteIncomingUserMessage(ctx);
        await replaceEphemeral(
          ctx,
          lock.code,
          `⚠️ Kamu masih punya pembayaran yang belum selesai.\n\nKode: \`${lock.code}\`\nBatas waktu: ${formatExpireIndo(lock.expiredAt)}\n\nSilakan lunasi pembayaran atau tunggu sampai EXPIRED.`,
          5000
        );
        return;
      }

      const st = getUserState(ctx.from.id);

      // In MENU or no state => allow chat (do not delete)
      if (!st || !st.page || st.page === "MENU") return next();

      // In submenu => delete all user chats incl /start
      if (st.page === "TOPUP_INPUT") {
        const amount = parseAmountText(txt);

        if (!amount) {
          await deleteIncomingUserMessage(ctx);
          const m = await ctx.reply(`⚠️ Masukkan angka saja ya. Contoh: ${MIN_TOPUP}`);
          setTimeout(() => safeDelete(ctx, m.chat.id, m.message_id), 2000);
          return;
        }
        if (amount < MIN_TOPUP) {
          await deleteIncomingUserMessage(ctx);
          const m = await ctx.reply(`⚠️ Minimal Rp ${rupiah(MIN_TOPUP)}`);
          setTimeout(() => safeDelete(ctx, m.chat.id, m.message_id), 2000);
          return;
        }
        if (amount > MAX_TOPUP) {
          await deleteIncomingUserMessage(ctx);
          const m = await ctx.reply(`⚠️ Maksimal Top Up Rp ${rupiah(MAX_TOPUP)}`);
          setTimeout(() => safeDelete(ctx, m.chat.id, m.message_id), 2000);
          return;
        }

        // VALID: keep this user message until QRIS is shown, then delete it.
        const userMsgRef = { chatId: ctx.chat.id, msgId: ctx.message.message_id };

        clearUserState(ctx.from.id);
        await clearWarn(ctx);
        await createTopupInvoice(ctx, amount, userMsgRef);
        return;
      }

      // other submenu pages: always delete and show "silahkan klik kembali" if /start
      await deleteIncomingUserMessage(ctx);

      if (txt === "/start") {
        await ctx.reply("⚠️ Silahkan klik kembali").then((m) => {
          setTimeout(() => safeDelete(ctx, m.chat.id, m.message_id), 2000);
        });
        return;
      }

      // ignore other text
      return;
    } catch (e) {
      console.error("global guard error:", e);
      return next();
    }
  });
}
