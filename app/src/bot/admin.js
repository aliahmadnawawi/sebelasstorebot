import { Markup } from "telegraf";
import { pool } from "../lib/db.js";

import { isAdmin, rupiah, parseAmountText, composeProductName, productTitleFromName } from "./helpers.js";
import { getAdminState, setAdminState, clearAdminState } from "./state.js";
import { uiNew, clearWarn, deleteIncomingUserMessage } from "./ui.js";

// ===================== helpers =====================
function adminMainKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📦 List Produk", "ADMIN_LIST"), Markup.button.callback("➕ Tambah Produk", "ADMIN_ADD")],
    [Markup.button.callback("🧩 Set Tipe Produk", "ADMIN_SET_TYPE"), Markup.button.callback("📖 Tutorial Admin", "ADMIN_HELP")],

    [Markup.button.callback("🟢/🔴 Toggle Aktif", "ADMIN_TOGGLE"), Markup.button.callback("🗑 Hapus Produk", "ADMIN_DELETE")],
    [Markup.button.callback("✏️ Ubah Harga", "ADMIN_EDIT_PRICE"), Markup.button.callback("✏️ Ubah Nama Produk", "ADMIN_RENAME")],

    [Markup.button.callback("🗂 Tambah Kategori", "ADMIN_CAT_ADD"), Markup.button.callback("📝 Ubah Nama Kategori", "ADMIN_CAT_RENAME")],

    [Markup.button.callback("💬 Chat User", "ADMIN_CHAT_USER"), Markup.button.callback("📣 Broadcast", "ADMIN_BROADCAST")],
    [Markup.button.callback("➕ Tambah Saldo User", "ADMIN_ADD_BALANCE"), Markup.button.callback("💰 Total Pendapatan", "ADMIN_REVENUE")],

    [Markup.button.callback("📦 Stock", "ADMIN_STOCK_MENU")],
    [Markup.button.callback("❌ Tutup", "ADMIN_CLOSE")],
  ]);
}

async function showAdminHome(ctx) {
  clearAdminState(ctx.from.id);
  setAdminState(ctx.from.id, { page: "ADMIN_HOME" });

  const text = "🔧 *Admin Panel*";
  return uiNew(ctx, text, adminMainKb());
}

async function loadCategories() {
  // pakai products.category kalau ada, fallback dari prefix name sebelum '|'
  const r = await pool.query(`
    select distinct
      coalesce(nullif(trim(category),''), trim(split_part(name,'|',1))) as cat
    from products
    where coalesce(nullif(trim(category),''), trim(split_part(name,'|',1))) is not null
    order by 1 asc
  `);
  return r.rows.map((x) => String(x.cat || "").trim()).filter(Boolean);
}

async function countsStockByProduct(productId) {
  const q = await pool.query(
    `
    select
      sum(case when is_used=false and code like 'INVITE_SLOT_%' then 1 else 0 end)::int as invite_left,
      sum(case when is_used=false and (code is null or code not like 'INVITE_SLOT_%') then 1 else 0 end)::int as payload_left
    from license_stock
    where product_id=$1
    `,
    [productId]
  );
  const row = q.rows[0] || {};
  return {
    inviteLeft: Number(row.invite_left || 0),
    payloadLeft: Number(row.payload_left || 0),
  };
}

function kbBackHome() {
  return Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_HOME")]]);
}

function genInviteSlotCode(i) {
  return `INVITE_SLOT_${Date.now()}_${Math.floor(Math.random() * 99999)}_${i}`;
}

// ===================== register =====================
export function registerAdmin(bot) {
  // /admin: tampilkan panel admin terbaru (hapus UI lama karena uiNew)
  bot.command("admin", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await clearWarn(ctx);
    await showAdminHome(ctx);
  });

  // HOME
  bot.action("ADMIN_HOME", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);
    await showAdminHome(ctx);
  });

  // CLOSE
  bot.action("ADMIN_CLOSE", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    clearAdminState(ctx.from.id);
    await uiNew(ctx, "✅ Admin panel ditutup.", Markup.inlineKeyboard([[Markup.button.callback("OK", "NOOP")]]));
  });

  // HELP
  bot.action("ADMIN_HELP", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    setAdminState(ctx.from.id, { page: "ADMIN_HELP" });

    const text =
`📖 *Tutorial Admin Panel*

*Tambah Produk*
1) Klik ➕ Tambah Produk
2) Pilih kategori (atau buat kategori dulu)
3) Ketik nama produk
4) Ketik harga
✅ Produk dibuat default type = *AUTO*

*Set Tipe Produk (bisa diubah kapan saja)*
1) Klik 🧩 Set Tipe Produk
2) Masukkan ID produk
3) Pilih: AUTO / LICENSE / INVITE

*Stock*
- Stock INVITE = slot invite (jumlah sisa).
- Stock AUTO/LICENSE = payload (akun/kode) yg akan diberikan.
Menu Stock:
- 📊 Ringkasan stock per produk
- 📃 List 30 terakhir
- ➕ Tambah stock
- 🗑 Hapus stock

*Chat User*
Format: \`<telegram_id>|<pesan>\`
Contoh: \`8213560167|Halo kak...\`

*Broadcast*
Ketik pesan → bot kirim ke semua user.

*Tambah Saldo User*
Format: \`<telegram_id>|<nominal>\`
Contoh: \`8213560167|50000\`

*Pendapatan*
Bot hitung total orders PAID & topups PAID.`;

    await uiNew(ctx, text, kbBackHome());
  });

  // ===================== LIST PRODUCTS =====================
  bot.action("ADMIN_LIST", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const cats = await loadCategories();
    if (cats.length === 0) {
      return uiNew(ctx, "Belum ada kategori/produk.", Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_HOME")]]));
    }

    setAdminState(ctx.from.id, { page: "ADMIN_LIST_PICK_CAT" });

    const rows = [];
    let row = [];
    cats.forEach((c) => {
      row.push(Markup.button.callback(c, `ADMIN_LIST_CAT:${encodeURIComponent(c)}`));
      if (row.length === 2) {
        rows.push(row);
        row = [];
      }
    });
    if (row.length) rows.push(row);
    rows.push([Markup.button.callback("« Kembali", "ADMIN_HOME")]);

    await uiNew(ctx, "Pilih kategori untuk list produk:", Markup.inlineKeyboard(rows));
  });

  bot.action(/^ADMIN_LIST_CAT:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const category = decodeURIComponent(ctx.match[1] || "");
    if (!category) return;

    const r = await pool.query(
      `
      select id, name, price, type, is_active, category
      from products
      where coalesce(nullif(trim(category),''), trim(split_part(name,'|',1)))=$1
      order by id asc
      `,
      [category]
    );

    if (r.rowCount === 0) {
      return uiNew(ctx, `Produk di kategori *${category}* belum ada.`, Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_LIST")]]));
    }

    const lines = [];
    for (const p of r.rows) {
      const title = productTitleFromName(p.name);
      const st = p.is_active ? "✅" : "⛔";
      const type = String(p.type || "").toUpperCase();
      const stock = await countsStockByProduct(Number(p.id));
      lines.push(
        `${st} *#${p.id}* ${title} — Rp ${rupiah(p.price)} — \`${type}\` — INV:${stock.inviteLeft} | PAY:${stock.payloadLeft}`
      );
    }

    await uiNew(
      ctx,
      `📦 *${category}*\n\n${lines.join("\n")}`,
      Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_LIST")], [Markup.button.callback("🏠 Home", "ADMIN_HOME")]])
    );
  });

  // ===================== ADD PRODUCT =====================
  bot.action("ADMIN_ADD", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const cats = await loadCategories();
    setAdminState(ctx.from.id, { page: "ADMIN_ADD_PICK_CAT" });

    const rows = [];
    let row = [];
    cats.forEach((c) => {
      row.push(Markup.button.callback(c, `ADMIN_ADD_CAT:${encodeURIComponent(c)}`));
      if (row.length === 2) {
        rows.push(row);
        row = [];
      }
    });
    if (row.length) rows.push(row);

    rows.push([Markup.button.callback("➕ Kategori Baru", "ADMIN_ADD_NEW_CAT")]);
    rows.push([Markup.button.callback("« Kembali", "ADMIN_HOME")]);

    await uiNew(ctx, "Pilih kategori untuk produk baru:", Markup.inlineKeyboard(rows));
  });

  bot.action("ADMIN_ADD_NEW_CAT", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    setAdminState(ctx.from.id, { page: "ADMIN_ADD_NEW_CAT" });
    await uiNew(ctx, "Ketik nama kategori baru:\nContoh: Tools Premium", kbBackHome());
  });

  bot.action(/^ADMIN_ADD_CAT:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const category = decodeURIComponent(ctx.match[1] || "");
    if (!category) return;

    setAdminState(ctx.from.id, { page: "ADMIN_ADD_TITLE", category });
    await uiNew(ctx, `Ketik *nama produk* untuk kategori *${category}*:\nContoh: Capcut Pro 1 Bulan`, kbBackHome());
  });

  // ===================== SET TYPE PRODUCT =====================
  bot.action("ADMIN_SET_TYPE", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    setAdminState(ctx.from.id, { page: "ADMIN_SET_TYPE" });
    await uiNew(ctx, "Ketik ID produk yang mau diubah tipenya.\nContoh: 12", kbBackHome());
  });

  bot.action(/^ADMIN_SET_TYPE_PICK:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const pid = Number(ctx.match[1]);
    if (!pid) return;

    setAdminState(ctx.from.id, { page: "ADMIN_SET_TYPE_PICK", productId: pid });

    await uiNew(
      ctx,
      `Pilih tipe untuk produk #${pid}:`,
      Markup.inlineKeyboard([
        [Markup.button.callback("AUTO", "ADMIN_TYPE:AUTO"), Markup.button.callback("LICENSE", "ADMIN_TYPE:LICENSE")],
        [Markup.button.callback("INVITE", "ADMIN_TYPE:INVITE")],
        [Markup.button.callback("« Kembali", "ADMIN_HOME")],
      ])
    );
  });

  bot.action(/^ADMIN_TYPE:(AUTO|LICENSE|INVITE)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const st = getAdminState(ctx.from.id);
    if (!st || st.page !== "ADMIN_SET_TYPE_PICK") return;

    const pid = Number(st.productId);
    const type = String(ctx.match[1]).toUpperCase();

    const r = await pool.query(`update products set type=$1 where id=$2 returning id`, [type, pid]);
    clearAdminState(ctx.from.id);

    if (r.rowCount === 0) return uiNew(ctx, "⚠️ Produk tidak ditemukan.", kbBackHome());
    await uiNew(ctx, `✅ Tipe produk #${pid} diubah jadi *${type}*`, adminMainKb());
  });

  // ===================== BASIC ACTIONS =====================
  bot.action("ADMIN_EDIT_PRICE", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    setAdminState(ctx.from.id, { page: "ADMIN_EDIT_PRICE" });
    await uiNew(ctx, "Ketik ID produk yang mau diubah harganya.\nContoh: 12", kbBackHome());
  });

  bot.action("ADMIN_RENAME", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    setAdminState(ctx.from.id, { page: "ADMIN_RENAME" });
    await uiNew(ctx, "Ketik ID produk yang mau diubah NAMA PRODUKNYA.\nContoh: 12", kbBackHome());
  });

  bot.action("ADMIN_TOGGLE", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    setAdminState(ctx.from.id, { page: "ADMIN_TOGGLE" });
    await uiNew(ctx, "Ketik ID produk yang mau di toggle aktif/nonaktif.\nContoh: 12", kbBackHome());
  });

  bot.action("ADMIN_DELETE", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    setAdminState(ctx.from.id, { page: "ADMIN_DELETE" });
    await uiNew(ctx, "Ketik ID produk yang mau dihapus.\nContoh: 12", kbBackHome());
  });

  // ===================== CATEGORY TOOLS =====================
  bot.action("ADMIN_CAT_ADD", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    setAdminState(ctx.from.id, { page: "ADMIN_CAT_ADD" });
    await uiNew(ctx, "Ketik nama kategori baru.\nContoh: Tools Premium", kbBackHome());
  });

  bot.action("ADMIN_CAT_RENAME", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    setAdminState(ctx.from.id, { page: "ADMIN_CAT_RENAME" });
    await uiNew(ctx, "Ketik format:\n`KategoriLama|KategoriBaru`\nContoh:\n`Capcut|Capcut Premium`", kbBackHome());
  });

  // ===================== CHAT USER / BROADCAST / BALANCE / REVENUE =====================
  bot.action("ADMIN_CHAT_USER", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    setAdminState(ctx.from.id, { page: "ADMIN_CHAT_USER" });
    await uiNew(ctx, "Ketik format:\n`<telegram_id>|<pesan>`\nContoh:\n`8213560167|Halo kak...`", kbBackHome());
  });

  bot.action("ADMIN_BROADCAST", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    setAdminState(ctx.from.id, { page: "ADMIN_BROADCAST" });
    await uiNew(ctx, "Ketik pesan broadcast (akan dikirim ke semua user).", kbBackHome());
  });

  bot.action("ADMIN_ADD_BALANCE", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    setAdminState(ctx.from.id, { page: "ADMIN_ADD_BALANCE" });
    await uiNew(ctx, "Ketik format:\n`<telegram_id>|<nominal>`\nContoh:\n`8213560167|50000`", kbBackHome());
  });

  bot.action("ADMIN_REVENUE", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    try {
      const orders = await pool.query(`
        select count(*)::int as cnt, coalesce(sum(total_amount),0)::bigint as total
        from orders
        where status='PAID'
      `);

      const topups = await pool.query(`
        select count(*)::int as cnt, coalesce(sum(base_amount),0)::bigint as total
        from topups
        where status='PAID'
      `);

      const o = orders.rows[0];
      const t = topups.rows[0];

      const text =
`💰 *Ringkasan Pendapatan*

✅ Orders PAID: *${o.cnt}* transaksi
Total dari order: *Rp ${rupiah(o.total)}*

✅ Topup PAID: *${t.cnt}* transaksi
Total topup: *Rp ${rupiah(t.total)}*`;

      await uiNew(ctx, text, kbBackHome());
    } catch (e) {
      console.error("ADMIN_REVENUE error:", e);
      await uiNew(ctx, "⚠️ Gagal hitung pendapatan. Pastikan schema orders/topups sesuai.", kbBackHome());
    }
  });

  // ===================== STOCK MENU =====================
  bot.action("ADMIN_STOCK_MENU", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    setAdminState(ctx.from.id, { page: "ADMIN_STOCK_MENU" });

    await uiNew(
      ctx,
      "📦 *Stock Menu*\n\nPilih aksi:",
      Markup.inlineKeyboard([
        [Markup.button.callback("📊 Ringkasan Stock", "ADMIN_STOCK_SUMMARY"), Markup.button.callback("📃 List 30 Terakhir", "ADMIN_STOCK_LIST30")],
        [Markup.button.callback("➕ Tambah Stock", "ADMIN_STOCK_ADD"), Markup.button.callback("🗑 Hapus Stock", "ADMIN_STOCK_DEL")],
        [Markup.button.callback("« Kembali", "ADMIN_HOME")],
      ])
    );
  });

  bot.action("ADMIN_STOCK_SUMMARY", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const r = await pool.query(`select id, name, price, type, is_active from products order by id asc`);
    if (r.rowCount === 0) return uiNew(ctx, "Belum ada produk.", Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_STOCK_MENU")]]));

    const lines = [];
    for (const p of r.rows) {
      const title = productTitleFromName(p.name);
      const type = String(p.type || "").toUpperCase();
      const st = p.is_active ? "✅" : "⛔";
      const stock = await countsStockByProduct(Number(p.id));
      lines.push(`${st} #${p.id} ${title} — \`${type}\` — INV:${stock.inviteLeft} | PAY:${stock.payloadLeft}`);
    }

    await uiNew(
      ctx,
      `📊 *Ringkasan Stock*\n\n${lines.join("\n")}`,
      Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_STOCK_MENU")]])
    );
  });

  bot.action("ADMIN_STOCK_LIST30", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const q = await pool.query(
      `
      select ls.id, ls.product_id, ls.is_used, ls.code, p.name, p.type
      from license_stock ls
      join products p on p.id=ls.product_id
      order by ls.id desc
      limit 30
      `
    );

    if (q.rowCount === 0) {
      return uiNew(ctx, "📃 Tidak ada stock (kosong).", Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_STOCK_MENU")]]));
    }

    const lines = q.rows.map((x) => {
      const title = productTitleFromName(x.name);
      const st = x.is_used ? "✅ USED" : "🟦 READY";
      const kind = String(x.code || "").startsWith("INVITE_SLOT_") ? "INVITE_SLOT" : "PAYLOAD";
      const preview = String(x.code || "").replace(/\n/g, " ").slice(0, 28);
      return `${st} #${x.id} — P#${x.product_id} — ${title} — ${String(x.type || "").toUpperCase()} — ${kind} — ${preview}`;
    });

    await uiNew(
      ctx,
      `📃 *Stock terakhir (30)*\n\n${lines.join("\n")}`,
      Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_STOCK_MENU")]])
    );
  });

  bot.action("ADMIN_STOCK_ADD", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    setAdminState(ctx.from.id, { page: "ADMIN_STOCK_ADD_PID" });
    await uiNew(ctx, "Ketik ID produk untuk tambah stock.\nContoh: 12", Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_STOCK_MENU")]]));
  });

  bot.action("ADMIN_STOCK_DEL", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    setAdminState(ctx.from.id, { page: "ADMIN_STOCK_DEL_PID" });
    await uiNew(ctx, "Ketik ID produk untuk hapus stock.\nContoh: 12", Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_STOCK_MENU")]]));
  });

  // ===================== WIZARD TEXT HANDLER =====================
  bot.on("text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();

    const txt = (ctx.message?.text || "").trim();
    if (!txt) return;

    const st = getAdminState(ctx.from.id);
    if (!st || !st.page) return;

    // selama di admin wizard: hapus pesan admin biar ga numpuk
    await deleteIncomingUserMessage(ctx);

    // --- ADD NEW CAT ---
    if (st.page === "ADMIN_ADD_NEW_CAT") {
      const category = txt.trim();
      if (!category) return uiNew(ctx, "⚠️ Nama kategori kosong.", kbBackHome());

      setAdminState(ctx.from.id, { page: "ADMIN_ADD_TITLE", category });
      return uiNew(ctx, `Ketik *nama produk* untuk kategori *${category}*:\nContoh: Capcut Pro 1 Bulan`, kbBackHome());
    }

    // --- ADD TITLE ---
    if (st.page === "ADMIN_ADD_TITLE") {
      const title = txt;
      setAdminState(ctx.from.id, { page: "ADMIN_ADD_PRICE", category: st.category, title });
      return uiNew(ctx, "Ketik harga (angka saja). Contoh: 5000", kbBackHome());
    }

    // --- ADD PRICE ---
    if (st.page === "ADMIN_ADD_PRICE") {
      const price = parseAmountText(txt);
      if (!price || price <= 0) return uiNew(ctx, "⚠️ Harga tidak valid. Ketik angka > 0.", kbBackHome());

      const category = String(st.category || "").trim();
      const title = String(st.title || "").trim();

      // default type = AUTO (karena products.type NOT NULL)
      const name = composeProductName(category, title);

      const ins = await pool.query(
        `insert into products (name, price, type, is_active, category) values ($1,$2,'AUTO',true,$3) returning id`,
        [name, Number(price), category]
      );

      clearAdminState(ctx.from.id);
      return uiNew(ctx, `✅ Produk ditambahkan:\n*#${ins.rows[0].id}* ${name}\nRp ${rupiah(price)}\nType: AUTO`, adminMainKb());
    }

    // --- SET TYPE: input product id ---
    if (st.page === "ADMIN_SET_TYPE") {
      const pid = Number(txt);
      if (!pid) return uiNew(ctx, "⚠️ ID tidak valid.", kbBackHome());

      const pr = await pool.query(`select id from products where id=$1`, [pid]);
      if (pr.rowCount === 0) return uiNew(ctx, "⚠️ Produk tidak ditemukan.", kbBackHome());

      // lanjut ke tombol pilih type
      return bot.telegram.answerCbQuery?.() && uiNew(ctx, "Pilih tipe:", Markup.inlineKeyboard([
        [Markup.button.callback("AUTO", "ADMIN_TYPE:AUTO"), Markup.button.callback("LICENSE", "ADMIN_TYPE:LICENSE")],
        [Markup.button.callback("INVITE", "ADMIN_TYPE:INVITE")],
        [Markup.button.callback("« Kembali", "ADMIN_HOME")],
      ])) && setAdminState(ctx.from.id, { page: "ADMIN_SET_TYPE_PICK", productId: pid });
    }

    // --- EDIT PRICE: step 1 ---
    if (st.page === "ADMIN_EDIT_PRICE") {
      const pid = Number(txt);
      if (!pid) return uiNew(ctx, "⚠️ ID tidak valid.", kbBackHome());
      setAdminState(ctx.from.id, { page: "ADMIN_EDIT_PRICE_STEP2", productId: pid });
      return uiNew(ctx, "Ketik harga baru (angka). Contoh: 15000", kbBackHome());
    }
    // --- EDIT PRICE: step 2 ---
    if (st.page === "ADMIN_EDIT_PRICE_STEP2") {
      const price = parseAmountText(txt);
      if (!price || price <= 0) return uiNew(ctx, "⚠️ Harga tidak valid.", kbBackHome());
      const pid = Number(st.productId);

      const r = await pool.query(`update products set price=$1 where id=$2 returning id`, [price, pid]);
      clearAdminState(ctx.from.id);

      if (r.rowCount === 0) return uiNew(ctx, "⚠️ Produk tidak ditemukan.", kbBackHome());
      return uiNew(ctx, `✅ Harga produk #${pid} diubah jadi Rp ${rupiah(price)}`, adminMainKb());
    }

    // --- RENAME PRODUCT: step 1 ---
    if (st.page === "ADMIN_RENAME") {
      const pid = Number(txt);
      if (!pid) return uiNew(ctx, "⚠️ ID tidak valid.", kbBackHome());
      const pr = await pool.query(`select id, category, name from products where id=$1`, [pid]);
      if (pr.rowCount === 0) return uiNew(ctx, "⚠️ Produk tidak ditemukan.", kbBackHome());

      setAdminState(ctx.from.id, { page: "ADMIN_RENAME_STEP2", productId: pid });
      return uiNew(ctx, "Ketik NAMA PRODUK BARU (tanpa kategori).\nContoh: Capcut Pro 1 Bulan", kbBackHome());
    }

    // --- RENAME PRODUCT: step 2 ---
    if (st.page === "ADMIN_RENAME_STEP2") {
      const pid = Number(st.productId);
      const newTitle = txt.trim();
      if (!newTitle) return uiNew(ctx, "⚠️ Nama kosong.", kbBackHome());

      const pr = await pool.query(`select category, name from products where id=$1`, [pid]);
      if (pr.rowCount === 0) return uiNew(ctx, "⚠️ Produk tidak ditemukan.", kbBackHome());

      const oldName = String(pr.rows[0].name || "");
      const category = String(pr.rows[0].category || "").trim() || String(oldName.split("|")[0] || "").trim();

      const newName = composeProductName(category, newTitle);
      await pool.query(`update products set name=$1, category=$2 where id=$3`, [newName, category, pid]);

      clearAdminState(ctx.from.id);
      return uiNew(ctx, `✅ Nama produk #${pid} diubah jadi:\n${newName}`, adminMainKb());
    }

    // --- TOGGLE ---
    if (st.page === "ADMIN_TOGGLE") {
      const pid = Number(txt);
      if (!pid) return uiNew(ctx, "⚠️ ID tidak valid.", kbBackHome());

      const r = await pool.query(`update products set is_active = not is_active where id=$1 returning is_active`, [pid]);
      clearAdminState(ctx.from.id);

      if (r.rowCount === 0) return uiNew(ctx, "⚠️ Produk tidak ditemukan.", kbBackHome());
      return uiNew(ctx, `✅ Produk #${pid} sekarang ${r.rows[0].is_active ? "AKTIF" : "NONAKTIF"}.`, adminMainKb());
    }

    // --- DELETE PRODUCT ---
    if (st.page === "ADMIN_DELETE") {
      const pid = Number(txt);
      if (!pid) return uiNew(ctx, "⚠️ ID tidak valid.", kbBackHome());

      const r = await pool.query(`delete from products where id=$1`, [pid]);
      clearAdminState(ctx.from.id);

      if (r.rowCount === 0) return uiNew(ctx, "⚠️ Produk tidak ditemukan.", kbBackHome());
      return uiNew(ctx, `✅ Produk #${pid} dihapus.`, adminMainKb());
    }

    // --- CAT ADD ---
    if (st.page === "ADMIN_CAT_ADD") {
      const cat = txt.trim();
      if (!cat) return uiNew(ctx, "⚠️ Nama kategori kosong.", kbBackHome());

      clearAdminState(ctx.from.id);
      return uiNew(ctx, `✅ Kategori dibuat: *${cat}*\n\n(cat tidak disimpan ke tabel khusus, tapi bisa kamu pakai saat add/rename produk)`, adminMainKb());
    }

    // --- CAT RENAME ---
    if (st.page === "ADMIN_CAT_RENAME") {
      const [oldCat, newCat] = txt.split("|").map((x) => (x || "").trim());
      if (!oldCat || !newCat) return uiNew(ctx, "⚠️ Format salah. Pakai `Lama|Baru`", kbBackHome());

      await pool.query(`update products set category=$1 where category=$2`, [newCat, oldCat]).catch(() => {});
      await pool.query(
        `
        update products
        set name = $1 || ' | ' || trim(split_part(name,'|',2))
        where trim(split_part(name,'|',1))=$2 and position('|' in name) > 0
        `,
        [newCat, oldCat]
      ).catch(() => {});

      clearAdminState(ctx.from.id);
      return uiNew(ctx, `✅ Rename kategori: *${oldCat}* → *${newCat}*`, adminMainKb());
    }

    // --- CHAT USER ---
    if (st.page === "ADMIN_CHAT_USER") {
      const [tg, ...rest] = txt.split("|");
      const telegramId = Number((tg || "").trim());
      const msg = rest.join("|").trim();
      if (!telegramId || !msg) return uiNew(ctx, "⚠️ Format salah. Pakai: `<telegram_id>|<pesan>`", kbBackHome());

      try {
        await bot.telegram.sendMessage(telegramId, msg);
        clearAdminState(ctx.from.id);
        return uiNew(ctx, `✅ Pesan terkirim ke ${telegramId}`, adminMainKb());
      } catch (e) {
        console.error("ADMIN_CHAT_USER error:", e);
        clearAdminState(ctx.from.id);
        return uiNew(ctx, "⚠️ Gagal kirim. Pastikan user pernah chat bot & telegram_id benar.", adminMainKb());
      }
    }

    // --- BROADCAST ---
    if (st.page === "ADMIN_BROADCAST") {
      const msg = txt;
      if (!msg) return uiNew(ctx, "⚠️ Pesan kosong.", kbBackHome());

      const u = await pool.query(`select telegram_id from users order by id asc`);
      await uiNew(ctx, `📣 Broadcast dimulai. Total user: ${u.rowCount}`, kbBackHome());

      let ok = 0, fail = 0;
      for (const row of u.rows) {
        const tgId = Number(row.telegram_id);
        try {
          await bot.telegram.sendMessage(tgId, msg);
          ok++;
        } catch {
          fail++;
        }
        await new Promise((r) => setTimeout(r, 60));
      }

      clearAdminState(ctx.from.id);
      return uiNew(ctx, `✅ Broadcast selesai.\nBerhasil: ${ok}\nGagal: ${fail}`, adminMainKb());
    }

    // --- ADD BALANCE ---
    if (st.page === "ADMIN_ADD_BALANCE") {
      const [tg, amt] = txt.split("|").map((x) => (x || "").trim());
      const telegramId = Number(tg);
      const amount = parseAmountText(amt);

      if (!telegramId || !amount || amount <= 0) return uiNew(ctx, "⚠️ Format salah. Pakai: `<telegram_id>|<nominal>`", kbBackHome());

      const r = await pool.query(
        `update users set balance = balance + $1 where telegram_id=$2 returning balance`,
        [amount, telegramId]
      );

      clearAdminState(ctx.from.id);
      if (r.rowCount === 0) return uiNew(ctx, "⚠️ User tidak ditemukan di database.", adminMainKb());

      return uiNew(
        ctx,
        `✅ Saldo ditambah.\nTelegram ID: ${telegramId}\nTambah: Rp ${rupiah(amount)}\nSaldo baru: Rp ${rupiah(r.rows[0].balance)}`,
        adminMainKb()
      );
    }

    // --- STOCK ADD: step 1 product id ---
    if (st.page === "ADMIN_STOCK_ADD_PID") {
      const pid = Number(txt);
      if (!pid) return uiNew(ctx, "⚠️ ID tidak valid.", Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_STOCK_MENU")]]));

      const pr = await pool.query(`select id, name, type from products where id=$1`, [pid]);
      if (pr.rowCount === 0) return uiNew(ctx, "⚠️ Produk tidak ditemukan.", Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_STOCK_MENU")]]));

      setAdminState(ctx.from.id, { page: "ADMIN_STOCK_ADD_KIND", productId: pid });

      const title = productTitleFromName(pr.rows[0].name);
      return uiNew(
        ctx,
        `Pilih jenis stock untuk produk #${pid} (${title}):`,
        Markup.inlineKeyboard([
          [Markup.button.callback("➕ INVITE Slot", "ADMIN_STOCK_ADD_INVITE"), Markup.button.callback("➕ PAYLOAD", "ADMIN_STOCK_ADD_PAYLOAD")],
          [Markup.button.callback("« Kembali", "ADMIN_STOCK_MENU")],
        ])
      );
    }

    // --- STOCK DEL: step 1 product id ---
    if (st.page === "ADMIN_STOCK_DEL_PID") {
      const pid = Number(txt);
      if (!pid) return uiNew(ctx, "⚠️ ID tidak valid.", Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_STOCK_MENU")]]));

      const pr = await pool.query(`select id, name from products where id=$1`, [pid]);
      if (pr.rowCount === 0) return uiNew(ctx, "⚠️ Produk tidak ditemukan.", Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_STOCK_MENU")]]));

      setAdminState(ctx.from.id, { page: "ADMIN_STOCK_DEL_KIND", productId: pid });

      const title = productTitleFromName(pr.rows[0].name);
      return uiNew(
        ctx,
        `Pilih hapus stock untuk produk #${pid} (${title}):`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🗑 Hapus INVITE Slot (N)", "ADMIN_STOCK_DEL_INVITE_N")],
          [Markup.button.callback("🗑 Hapus 1 PAYLOAD READY", "ADMIN_STOCK_DEL_PAYLOAD_1")],
          [Markup.button.callback("« Kembali", "ADMIN_STOCK_MENU")],
        ])
      );
    }

    // --- STOCK ADD INVITE: ask count ---
    if (st.page === "ADMIN_STOCK_ADD_INVITE_COUNT") {
      const pid = Number(st.productId);
      const n = Number(txt);
      if (!n || n <= 0 || n > 500) return uiNew(ctx, "⚠️ Jumlah tidak valid (1-500).", Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_STOCK_MENU")]]));

      const vals = [];
      for (let i = 0; i < n; i++) {
        vals.push([pid, genInviteSlotCode(i)]);
      }

      // bulk insert
      const placeholders = vals.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}, false)`).join(",");
      const flat = vals.flat();

      await pool.query(`insert into license_stock (product_id, code, is_used) values ${placeholders}`, flat);

      clearAdminState(ctx.from.id);
      return uiNew(ctx, `✅ INVITE slot ditambahkan: *${n}* untuk produk #${pid}`, adminMainKb());
    }

    // --- STOCK ADD PAYLOAD: payload text ---
    if (st.page === "ADMIN_STOCK_ADD_PAYLOAD_TEXT") {
      const pid = Number(st.productId);
      const payload = txt;
      if (!payload) return uiNew(ctx, "⚠️ Payload kosong.", Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_STOCK_MENU")]]));

      await pool.query(`insert into license_stock (product_id, code, is_used) values ($1,$2,false)`, [pid, payload]);

      clearAdminState(ctx.from.id);
      return uiNew(ctx, `✅ 1 payload ditambahkan ke produk #${pid}`, adminMainKb());
    }

    // --- STOCK DEL INVITE N ---
    if (st.page === "ADMIN_STOCK_DEL_INVITE_COUNT") {
      const pid = Number(st.productId);
      const n = Number(txt);
      if (!n || n <= 0 || n > 500) return uiNew(ctx, "⚠️ Jumlah tidak valid (1-500).", Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_STOCK_MENU")]]));

      const del = await pool.query(
        `
        delete from license_stock
        where id in (
          select id from license_stock
          where product_id=$1 and is_used=false and code like 'INVITE_SLOT_%'
          order by id asc
          limit $2
        )
        returning id
        `,
        [pid, n]
      );

      clearAdminState(ctx.from.id);
      return uiNew(ctx, `✅ INVITE slot terhapus: *${del.rowCount}* dari request *${n}* (produk #${pid})`, adminMainKb());
    }

    return next();
  });

  // ===================== STOCK ADD callbacks =====================
  bot.action("ADMIN_STOCK_ADD_INVITE", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const st = getAdminState(ctx.from.id);
    if (!st || st.page !== "ADMIN_STOCK_ADD_KIND") return;

    setAdminState(ctx.from.id, { page: "ADMIN_STOCK_ADD_INVITE_COUNT", productId: st.productId });
    await uiNew(ctx, "Ketik jumlah INVITE slot yang mau ditambah.\nContoh: 11", Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_STOCK_MENU")]]));
  });

  bot.action("ADMIN_STOCK_ADD_PAYLOAD", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const st = getAdminState(ctx.from.id);
    if (!st || st.page !== "ADMIN_STOCK_ADD_KIND") return;

    setAdminState(ctx.from.id, { page: "ADMIN_STOCK_ADD_PAYLOAD_TEXT", productId: st.productId });
    await uiNew(ctx, "Ketik isi payload (akun/kode). Bisa multi-line.\nAkan disimpan sebagai 1 item.", Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_STOCK_MENU")]]));
  });

  // ===================== STOCK DEL callbacks =====================
  bot.action("ADMIN_STOCK_DEL_INVITE_N", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const st = getAdminState(ctx.from.id);
    if (!st || st.page !== "ADMIN_STOCK_DEL_KIND") return;

    setAdminState(ctx.from.id, { page: "ADMIN_STOCK_DEL_INVITE_COUNT", productId: st.productId });
    await uiNew(ctx, "Ketik jumlah INVITE slot yang mau dihapus.\nContoh: 11", Markup.inlineKeyboard([[Markup.button.callback("« Kembali", "ADMIN_STOCK_MENU")]]));
  });

  bot.action("ADMIN_STOCK_DEL_PAYLOAD_1", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await clearWarn(ctx);

    const st = getAdminState(ctx.from.id);
    if (!st || st.page !== "ADMIN_STOCK_DEL_KIND") return;

    const pid = Number(st.productId);

    const del = await pool.query(
      `
      delete from license_stock
      where id = (
        select id from license_stock
        where product_id=$1 and is_used=false and (code is null or code not like 'INVITE_SLOT_%')
        order by id asc
        limit 1
      )
      returning id
      `,
      [pid]
    );

    clearAdminState(ctx.from.id);

    if (del.rowCount === 0) {
      return uiNew(ctx, "⚠️ Tidak ada PAYLOAD READY untuk dihapus.", adminMainKb());
    }
    return uiNew(ctx, `✅ 1 payload READY dihapus (stock id: ${del.rows[0].id}) untuk produk #${pid}`, adminMainKb());
  });

  // NOOP
  bot.action("NOOP", async (ctx) => ctx.answerCbQuery());
}
