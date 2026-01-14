import { pool } from "../lib/db.js";
import { composeProductName } from "./helpers.js";

// ================== FIXED CATEGORIES & DEFAULT PRODUCTS ==================
export const DEFAULT_CATEGORIES = [
  "Sosial Media",
  "Chat GPT",
  "Gemini",
  "Canva",
  "Capcut",
  "Produk Aktivasi",
  "Github",
  "Jasa",
  "Netflix",
  "Layanan",
  "Otp",
];

export const DEFAULT_PRODUCTS = [
  // Sosial Media (INVITE)
  { category: "Sosial Media", title: "Instagram Fresh", price: 2000, type: "INVITE" },
  { category: "Sosial Media", title: "Facebook Fresh", price: 2000, type: "INVITE" },
  { category: "Sosial Media", title: "Twitter Fresh", price: 2000, type: "INVITE" },
  { category: "Sosial Media", title: "Tiktok Fresh", price: 2000, type: "INVITE" },

  // Chat GPT (INVITE)
  { category: "Chat GPT", title: "CG Plus 1 Tahun", price: 100000, type: "INVITE" },
  { category: "Chat GPT", title: "CG Plus 1 Bulan", price: 10000, type: "INVITE" },
  { category: "Chat GPT", title: "CG Teacher 2 Tahun", price: 20000, type: "INVITE" },
  { category: "Chat GPT", title: "CG GO 1 Tahun", price: 15000, type: "INVITE" },

  // Gemini (INVITE)
  { category: "Gemini", title: "Gemini Pro 1 Tahun", price: 25000, type: "INVITE" },
  { category: "Gemini", title: "G Invite 1 Tahun", price: 15000, type: "INVITE" },
  { category: "Gemini", title: "G Invite 1 Bulan", price: 1000, type: "INVITE" },
  { category: "Gemini", title: "G Invite 2 Bulan", price: 2000, type: "INVITE" },
  { category: "Gemini", title: "G Invite 3 Bulan", price: 3000, type: "INVITE" },
  { category: "Gemini", title: "G Invite 4 Bulan", price: 4000, type: "INVITE" },
  { category: "Gemini", title: "G Invite 5 Bulan", price: 5000, type: "INVITE" },
  { category: "Gemini", title: "G Invite 6 Bulan", price: 6000, type: "INVITE" },

  // Canva (INVITE)
  { category: "Canva", title: "Canva Edu Lifetime", price: 15000, type: "INVITE" },
  { category: "Canva", title: "Canva Pro 1 Tahun", price: 50000, type: "INVITE" },

  // Capcut (INVITE)
  { category: "Capcut", title: "Capcut Pro 6 Bulan", price: 30000, type: "INVITE" },
  { category: "Capcut", title: "Capcut Pro 3 Bulan", price: 15000, type: "INVITE" },
  { category: "Capcut", title: "Capcut Pro 1 Bulan", price: 5000, type: "INVITE" },
  { category: "Capcut", title: "Capcut Creator", price: 10000, type: "INVITE" },
  { category: "Capcut", title: "Capcut Fresh", price: 1000, type: "INVITE" },

  // Produk Aktivasi (INVITE)
  { category: "Produk Aktivasi", title: "Windows 10 Pro", price: 25000, type: "INVITE" },
  { category: "Produk Aktivasi", title: "Windows 11 Pro", price: 50000, type: "INVITE" },

  // Github (INVITE)
  { category: "Github", title: "Github Student", price: 90000, type: "INVITE" },
  { category: "Github", title: "Github Fresh", price: 10000, type: "INVITE" },

  // Netflix (INVITE)
  { category: "Netflix", title: "Netflix 1p1u 1 Bulan", price: 35000, type: "INVITE" },

  // Layanan (INVITE)
  { category: "Layanan", title: "WhatsApp Verified", price: 900000, type: "INVITE" },

  // Otp (INVITE)
  { category: "Otp", title: "WhatsApp", price: 10000, type: "INVITE" },
  { category: "Otp", title: "Telegram", price: 9000, type: "INVITE" },
];

// ================== INVITE SLOT (11) ==================
export async function ensureInviteSlots(productId, targetSlots = 11) {
  try {
    const q = await pool.query(
      `select count(*)::int as left
       from license_stock
       where product_id=$1 and is_used=false and code like 'INVITE_SLOT_%'`,
      [productId]
    );
    const left = Number(q.rows[0]?.left || 0);
    const need = Math.max(0, targetSlots - left);
    if (need === 0) return;

    const values = [];
    const params = [];
    for (let i = 0; i < need; i++) {
      params.push(productId, `INVITE_SLOT_${Date.now()}_${i}_${Math.floor(Math.random() * 100000)}`);
      const idx = i * 2;
      values.push(`($${idx + 1}, $${idx + 2}, false)`);
    }
    await pool.query(`insert into license_stock (product_id, code, is_used) values ${values.join(",")}`, params);
  } catch (e) {
    console.error("ensureInviteSlots error:", e);
  }
}

export async function ensureDefaultProductsOnBoot() {
  try {
    for (const p of DEFAULT_PRODUCTS) {
      const name = composeProductName(p.category, p.title);
      const exists = await pool.query(`select id, type from products where name=$1 limit 1`, [name]);

      let productId = null;
      let type = String(p.type || "INVITE").toUpperCase();

      if (exists.rowCount === 0) {
        const ins = await pool.query(
          `insert into products (name, price, type, is_active) values ($1,$2,$3,true) returning id`,
          [name, Number(p.price), type]
        );
        productId = Number(ins.rows[0]?.id);
      } else {
        productId = Number(exists.rows[0]?.id);
        type = String(exists.rows[0]?.type || type).toUpperCase();
      }

      if (productId && type === "INVITE") {
        await ensureInviteSlots(productId, 11);
      }
    }
  } catch (e) {
    console.error("ensureDefaultProductsOnBoot error:", e);
  }
}
