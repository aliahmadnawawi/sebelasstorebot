import { uiMsgByUser, warnMsgByUser, transientByCode, checkCooldownUntil } from "./state.js";

export async function safeDelete(ctx, chatId, msgId) {
  if (!chatId || !msgId) return;
  try { await ctx.telegram.deleteMessage(chatId, msgId); } catch {}
}

export async function deleteIncomingUserMessage(ctx) {
  try {
    if (ctx?.chat?.id && ctx?.message?.message_id) {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
    }
  } catch {}
}

export async function uiNew(ctx, text, kb) {
  const tgId = String(ctx.from.id);
  const old = uiMsgByUser.get(tgId);
  if (old) await safeDelete(ctx, old.chatId, old.msgId);

  const m = await ctx.reply(text, { parse_mode: "Markdown", ...(kb ? kb : {}) });
  uiMsgByUser.set(tgId, { chatId: m.chat.id, msgId: m.message_id });
  return m;
}

export async function uiEdit(ctx, text, kb) {
  const tgId = String(ctx.from.id);
  const cur = uiMsgByUser.get(tgId);
  if (!cur) return uiNew(ctx, text, kb);

  try {
    const m = await ctx.telegram.editMessageText(cur.chatId, cur.msgId, undefined, text, {
      parse_mode: "Markdown",
      ...(kb ? kb : {}),
    });

    // Penting: m kadang boolean di beberapa kondisi, jadi kalau bukan object, fallback ke cur
    if (m && typeof m === "object" && m.chat?.id && m.message_id) {
      uiMsgByUser.set(tgId, { chatId: m.chat.id, msgId: m.message_id });
      return m;
    }

    // fallback: balikin "message-like" object supaya caller gak crash
    return { chat: { id: cur.chatId }, message_id: cur.msgId };
  } catch {
    return uiNew(ctx, text, kb);
  }
}

export async function setWarn(ctx, text, ttlMs = 2000) {
  const tgId = String(ctx.from.id);
  const old = warnMsgByUser.get(tgId);
  if (old) await safeDelete(ctx, old.chatId, old.msgId);

  const m = await ctx.reply(text);
  warnMsgByUser.set(tgId, { chatId: m.chat.id, msgId: m.message_id });

  setTimeout(() => {
    safeDelete(ctx, m.chat.id, m.message_id);
    const cur = warnMsgByUser.get(tgId);
    if (cur?.msgId === m.message_id) warnMsgByUser.delete(tgId);
  }, ttlMs);
}

export async function clearWarn(ctx) {
  const tgId = String(ctx.from.id);
  const old = warnMsgByUser.get(tgId);
  if (old) await safeDelete(ctx, old.chatId, old.msgId);
  warnMsgByUser.delete(tgId);
}

// ===== transient helpers =====
function ensureTransient(code) {
  const cur = transientByCode.get(code) || { timers: [] };
  transientByCode.set(code, cur);
  return cur;
}

export function rememberTimer(code, id) {
  const cur = ensureTransient(code);
  cur.timers.push(id);
}

export function rememberQris(code, chatId, msgId) {
  const cur = ensureTransient(code);
  cur.qris = { chatId, msgId };
}

export async function replaceEphemeral(ctx, code, text, ttlMs) {
  const cur = ensureTransient(code);
  if (cur.ephem) await safeDelete(ctx, cur.ephem.chatId, cur.ephem.msgId);

  const m = await ctx.reply(text);
  cur.ephem = { chatId: m.chat.id, msgId: m.message_id };

  const t = setTimeout(async () => {
    const latest = transientByCode.get(code);
    if (latest?.ephem?.msgId === m.message_id) {
      await safeDelete(ctx, m.chat.id, m.message_id);
      const c = transientByCode.get(code);
      if (c) c.ephem = null;
    }
  }, ttlMs);

  rememberTimer(code, t);
}

export async function cleanupCodeAll(ctx, code) {
  const cur = transientByCode.get(code);
  if (!cur) return;

  for (const tid of cur.timers || []) {
    try { clearTimeout(tid); } catch {}
  }
  if (cur.ephem) await safeDelete(ctx, cur.ephem.chatId, cur.ephem.msgId);
  if (cur.qris) await safeDelete(ctx, cur.qris.chatId, cur.qris.msgId);

  transientByCode.delete(code);
  checkCooldownUntil.delete(code);
}
