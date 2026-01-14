import { Markup } from "telegraf";
import { pool, getOrCreateUser } from "../lib/db.js";

import { PAGE_SIZE } from "./config.js";
import { DEFAULT_CATEGORIES } from "./seed.js";
import { getLock, getUserState, setUserState } from "./state.js";
import { uiEdit, safeDelete, clearWarn } from "./ui.js";
import { rupiah, pageNumberLabel, productTitleFromName } from "./helpers.js";

async function sendCategoryPage(ctx, page = 0) {
  const lock = getLock(ctx.from.id);
  if (lock) return;

  const cats = DEFAULT_CATEGORIES.slice();
  const maxPage = Math.max(0, Math.ceil(cats.length / PAGE_SIZE) - 1);
  const p = Math.min(Math.max(0, page), maxPage);

  const start = p * PAGE_SIZE;
  const slice = cats.slice(start, start + PAGE_SIZE);

  setUserState(ctx.from.id, { page: "CAT", p });

  const lines = slice.map((c, i) => `*${pageNumberLabel(p, i)}.* ${c}`).join("\n");
  const text = `🛒 *Kategori Produk* (hal ${p + 1}/${maxPage + 1})

${lines}

Pilih dengan tombol angka di bawah.`;

  const numRow = slice.map((_, i) => Markup.button.callback(pageNumberLabel(p, i), `CATSEL:${p}:${i}`));

  const navRow = [];
  if (p === 0) navRow.push(Markup.button.callback("« Kembali", "MAIN_MENU"));
  else navRow.push(Markup.button.callback("« Sebelumnya", `CAT_PAGE:${p - 1}`));

  if (p < maxPage) navRow.push(Markup.button.callback("Selanjutnya »", `CAT_PAGE:${p + 1}`));
  else navRow.push(Markup.button.callback("Selanjutnya »", `NOOP`));

  const kb = Markup.inlineKeyboard([numRow, navRow]);
  await uiEdit(ctx, text, kb);
}

async function sendProductsPage(ctx, category, page = 0, catPage = 0) {
  const lock = getLock(ctx.from.id);
  if (lock) return;

  const r = await pool.query(
    `select id,name,price,type
     from products
     where is_active=true and trim(split_part(name,'|',1))=$1
     order by id asc`,
    [String(category).trim()]
  );

  const allItems = r.rows.map((p) => ({
    id: Number(p.id),
    name: p.name,
    title: productTitleFromName(p.name),
    price: Number(p.price || 0),
    type: String(p.type || "").toUpperCase(),
  }));

  if (allItems.length === 0) {
    const m = await ctx.reply("Produk di kategori ini belum tersedia.");
    setTimeout(() => safeDelete(ctx, m.chat.id, m.message_id), 2000);
    return;
  }

  const maxPage = Math.max(0, Math.ceil(allItems.length / PAGE_SIZE) - 1);
  const p = Math.min(Math.max(0, page), maxPage);

  const start = p * PAGE_SIZE;
  const slice = allItems.slice(start, start + PAGE_SIZE);

  setUserState(ctx.from.id, { page: "PROD", category, p, items: allItems, catPage });

  const list = slice.map((it, i) => `*${pageNumberLabel(p, i)}.* ${it.title} (Rp ${rupiah(it.price)})`).join("\n");
  const text = `📦 *Daftar Produk* (hal ${p + 1}/${maxPage + 1})

${list}

Pilih dengan tombol angka di bawah.`;

  const numRow = slice.map((_, i) =>
    Markup.button.callback(pageNumberLabel(p, i), `PRODSEL:${encodeURIComponent(category)}:${p}:${i}`)
  );

  const navRow = [];
  if (p === 0) {
    navRow.push(Markup.button.callback("« Kembali", `CAT_PAGE:${catPage}`));
    if (p < maxPage) navRow.push(Markup.button.callback("Selanjutnya »", `PROD_PAGE:${encodeURIComponent(category)}:${p + 1}`));
    else navRow.push(Markup.button.callback("Selanjutnya »", "NOOP"));
  } else {
    navRow.push(Markup.button.callback("« Sebelumnya", `PROD_PAGE:${encodeURIComponent(category)}:${p - 1}`));
    if (p < maxPage) navRow.push(Markup.button.callback("Selanjutnya »", `PROD_PAGE:${encodeURIComponent(category)}:${p + 1}`));
    else navRow.push(Markup.button.callback("Selanjutnya »", "NOOP"));
  }

  const kb = Markup.inlineKeyboard([numRow, navRow]);
  await uiEdit(ctx, text, kb);
}

export function registerCatalog(bot) {
  bot.action("CATALOG", async (ctx) => {
    await ctx.answerCbQuery();
    await clearWarn(ctx);
    await sendCategoryPage(ctx, 0);
  });

  bot.action(/^CAT_PAGE:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await clearWarn(ctx);
    await sendCategoryPage(ctx, Number(ctx.match[1] || 0));
  });

  bot.action(/^CATSEL:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const st = getUserState(ctx.from.id);
    if (!st || st.page !== "CAT") return;

    const p = Number(ctx.match[1]);
    const i = Number(ctx.match[2]);

    const start = p * PAGE_SIZE;
    const slice = DEFAULT_CATEGORIES.slice(start, start + PAGE_SIZE);
    const category = slice[i];
    if (!category) return;

    const exists = await pool.query(
      `select 1 from products where is_active=true and trim(split_part(name,'|',1))=$1 limit 1`,
      [String(category).trim()]
    );
    if (exists.rowCount === 0) {
      const m = await ctx.reply("Produk di kategori ini belum tersedia.");
      setTimeout(() => safeDelete(ctx, m.chat.id, m.message_id), 2000);
      return;
    }

    await sendProductsPage(ctx, category, 0, p);
  });

  bot.action(/^PROD_PAGE:([^:]+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const category = decodeURIComponent(ctx.match[1]);
    const page = Number(ctx.match[2] || 0);

    const st = getUserState(ctx.from.id);
    const catPage = st?.catPage ?? 0;

    await sendProductsPage(ctx, category, page, catPage);
  });

  bot.action(/^PRODSEL:([^:]+):(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const st = getUserState(ctx.from.id);
    if (!st || st.page !== "PROD") return;

    const category = decodeURIComponent(ctx.match[1]);
    const p = Number(ctx.match[2]);
    const i = Number(ctx.match[3]);

    if (st.category !== category) return;

    const start = p * PAGE_SIZE;
    const slice = st.items.slice(start, start + PAGE_SIZE);
    const prod = slice[i];
    if (!prod) return;

    setUserState(ctx.from.id, {
      page: "PAY",
      productId: prod.id,
      category: st.category,
      p: st.p,
      catPage: st.catPage,
    });

    const text =
  `*Nama Produk:* ${prod.title}\n` +
  `*Harga:* Rp ${rupiah(prod.price)}\n\n` +
  `Silakan pilih metode bayar:`;

    const kb = Markup.inlineKeyboard([
  [
    Markup.button.callback("💳 Bayar QRIS", `PAYQRIS:${prod.id}`),
    Markup.button.callback("💰 Bayar Saldo", `PAYSALDO:${prod.id}`),
  ],
  [
    Markup.button.callback("« Kembali", `PROD_PAGE:${encodeURIComponent(st.category)}:${st.p}`),
  ],
]);

    await uiEdit(ctx, text, kb);
  });

      // HISTORY
  bot.action("HISTORY", async (ctx) => {
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const lock = getLock(ctx.from.id);
    if (lock) return;

    const u = await getOrCreateUser(ctx.from.id);
    const fullName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ").trim() || "-";

    const q = await pool.query(
      `
      select
        'ORDER' as kind,
        o.order_code as code,
        o.total_amount as total,
        o.paid_at as t,
        p.name as product_name
      from orders o
      join products p on p.id=o.product_id
      where o.user_id=$1 and o.status='PAID'
      union all
      select
        'TOPUP' as kind,
        t.topup_code as code,
        t.total_amount as total,
        t.paid_at as t,
        'Top Up Saldo' as product_name
      from topups t
      where t.user_id=$1 and t.status='PAID'
      order by t desc nulls last
      limit 20
      `,
      [u.id]
    );

    const totalSpent = q.rows.reduce((acc, x) => acc + Number(x.total || 0), 0);

    let blocks = "";
    if (q.rowCount > 0) {
      blocks = q.rows
        .map((x) => {
          const prodTitle = x.kind === "ORDER" ? productTitleFromName(x.product_name) : "Top Up Saldo";
          const labelCode = x.kind === "ORDER" ? "Order" : "Kode";

          // IMPORTANT: pakai code block, jangan pakai backtick di dalamnya lagi
          return (
            "```Invoice\n" +
            `Produk: ${prodTitle}\n` +
            `${labelCode}: ${x.code}\n` +
            `Total bayar: Rp ${rupiah(x.total)}\n` +
            "Status: Sukses```"
          );
        })
        .join("\n\n");
    }

    if (!blocks) {
      blocks = "```Belum ada transaksi sukses.```";
    }

    const text =
      `📃 Riwayat Saya\n\n` +
      `﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌\n` +
      `👤 Nama: ${fullName}\n` +
      `💰 Total transaksi: Rp ${rupiah(totalSpent)}\n\n` +
      `﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌\n` +
      `${blocks}`;

    setUserState(ctx.from.id, { page: "HISTORY" });

    // NOTE: parse_mode Markdown masih aman, karena code fence kamu valid
    const kb = Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "MAIN_MENU")]]);
    await uiEdit(ctx, text, kb);
  });
}
