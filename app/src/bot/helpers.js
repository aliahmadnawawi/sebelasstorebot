import { ADMIN, PAGE_SIZE } from "./config.js";

export function isAdmin(ctx) {
  return String(ctx.from?.id) === ADMIN;
}

export function rupiah(n) {
  const x = Number(n || 0);
  return String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export function formatWIB_HHmm(dateObj) {
  return dateObj
    .toLocaleTimeString("id-ID", {
      timeZone: "Asia/Jakarta",
      hour: "2-digit",
      minute: "2-digit",
    })
    .replace(":", ".");
}

export function formatTanggalIndo(dateObj) {
  const parts = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(dateObj);

  const dd = parts.find((p) => p.type === "day")?.value || "01";
  const mm = parts.find((p) => p.type === "month")?.value || "01";
  const yyyy = parts.find((p) => p.type === "year")?.value || "1970";
  return `${dd}/${mm}/${yyyy}`;
}

export function formatExpireIndo(dateObj) {
  return `${formatTanggalIndo(dateObj)} ${formatWIB_HHmm(dateObj)} WIB`;
}

export function fullNameFromCtx(ctx) {
  return [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ").trim();
}

export function parseAmountText(txt) {
  const raw = String(txt || "").trim().replace(/[.\s]/g, "");
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

export function composeProductName(category, title) {
  return `${String(category).trim()} | ${String(title).trim()}`;
}

export function productCategoryFromName(name) {
  const s = String(name || "");
  const parts = s.split("|").map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[0];
  return "Produk";
}

export function productTitleFromName(name) {
  const s = String(name || "");
  const parts = s.split("|").map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) return parts.slice(1).join(" | ");
  return s;
}

export function isPaidFromDetail(detail) {
  const s = JSON.stringify(detail ?? {}).toLowerCase();
  if (/"status"\s*:\s*"(pending|unpaid|expire|expired|failed|fail|cancel|canceled)"/.test(s)) return false;
  if (/"status"\s*:\s*"completed"/.test(s)) return true;
  if (/"completed"\s*:\s*true/.test(s)) return true;
  if (/"paid"\s*:\s*true/.test(s)) return true;
  if (/"is_paid"\s*:\s*true/.test(s)) return true;
  return false;
}

export function nowMs() { return Date.now(); }

export function pageNumberLabel(page, i) {
  return String(page * PAGE_SIZE + i + 1);
}
