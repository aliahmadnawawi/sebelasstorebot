import { Markup } from "telegraf";
import { getOrCreateUser } from "../lib/db.js";
import { ADMIN_CONTACT_URL, CHANNEL_URL } from "./config.js";
import { setUserState, getUserState, clearUserState } from "./state.js";
import { uiNew, uiEdit, clearWarn, setWarn, deleteIncomingUserMessage } from "./ui.js";
import { fullNameFromCtx } from "./helpers.js";

export async function sendMainMenu(ctx, mode = "edit") {
  const first = ctx.from?.first_name || "Kak";
  const text = `🎉 Selamat datang di *Sebelas Storebot*!

👋 Halo *${first}*!

*Kami menyediakan layanan:*

- Produk Digital
- Jasa
- Dan lain-lain

*Silakan pilih menu:*`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("🛒 Katalog", "CATALOG"), Markup.button.callback("📃 Riwayat Saya", "HISTORY")],
    [Markup.button.callback("💰 Saldo", "BALANCE"), Markup.button.callback("☎️ Bantuan", "HELP")],
    [Markup.button.callback("🖥 Produk Saya", "MY_PRODUCTS")],
    [Markup.button.callback("❗️FAQ", "FAQ")],
    [Markup.button.callback("ℹ️ Tentang Kami", "ABOUT")],
  ]);

  if (mode === "new") return uiNew(ctx, text, kb);
  return uiEdit(ctx, text, kb);
}

export function registerMenu(bot) {
  bot.start(async (ctx) => {
    await getOrCreateUser(ctx.from.id);

    const st = getUserState(ctx.from.id);
    if (st && st.page && st.page !== "MENU") {
      await deleteIncomingUserMessage(ctx);
      await setWarn(ctx, "⚠️ Silahkan klik kembali", 2000);
      return;
    }

    await clearWarn(ctx);

    clearUserState(ctx.from.id);
    setUserState(ctx.from.id, { page: "MENU" });

    await sendMainMenu(ctx, "new");
  });

  bot.action("MAIN_MENU", async (ctx) => {
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    clearUserState(ctx.from.id);
    setUserState(ctx.from.id, { page: "MENU" });

    await sendMainMenu(ctx, "edit");
  });

  // ================== HELP / ABOUT / FAQ ==================
  bot.action("HELP", async (ctx) => {
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    setUserState(ctx.from.id, { page: "HELP" });

    const text = `☎️ *Bantuan*

Jika ada kendala, klik tombol di bawah untuk chat admin.`;

    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("« Kembali", "MAIN_MENU"), Markup.button.url("💬 Chat Admin", ADMIN_CONTACT_URL)],
    ]);
    await uiEdit(ctx, text, kb);
  });

  bot.action("ABOUT", async (ctx) => {
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    setUserState(ctx.from.id, { page: "ABOUT" });

    const fullName = fullNameFromCtx(ctx) || "Kak";
    const text = `👋 Halo ${fullName}!

Selamat datang di Sebelas Storebot, platform layanan otomasi terpercaya di bawah naungan Sebelas Indonesia.

Kami hadir sebagai solusi satu pintu untuk membantu Anda meningkatkan performa digital secara instan, aman, dan berkualitas.

🚀 Storebot 1.0`;

    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("« Kembali", "MAIN_MENU"), Markup.button.url("Gabung Channel", CHANNEL_URL)],
    ]);
    await uiEdit(ctx, text, kb);
  });

  bot.action("FAQ", async (ctx) => {
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    setUserState(ctx.from.id, { page: "FAQ" });

    const text = `❗️ *FAQ*

*1) Cara Order Produk*
- Klik 🛒 Katalog
- Pilih kategori → pilih produk
- Pilih metode bayar (QRIS / Saldo)
- Untuk produk *INVITE*: kamu akan diminta chat admin

*2) Cara Top Up*
- Klik 💰 Saldo → Top Up
- Ketik nominal (angka saja)
- Bayar QRIS, lalu tekan 🔄 Cek Status

*3) QRIS*
- QRIS punya batas waktu
- Jika expired, invoice akan dihapus otomatis dan menu akan tampil lagi

*Rules*
- Jangan spam klik tombol, tunggu respon
- Jika ada kendala, chat admin lewat menu Bantuan`;

    const kb = Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "MAIN_MENU")]]);
    await uiEdit(ctx, text, kb);
  });
}
