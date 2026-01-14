export const userState = new Map();        // tgId -> state
export const adminState = new Map();       // tgId -> state
export const uiMsgByUser = new Map();      // tgId -> { chatId, msgId }
export const warnMsgByUser = new Map();    // tgId -> { chatId, msgId }
export const transientByCode = new Map();  // code -> { qris, ephem, timers:[] }
export const lockByUser = new Map();       // tgId -> { kind, code, expiredAt }
export const checkCooldownUntil = new Map(); // code -> ms

export function setUserState(tgId, state) { userState.set(String(tgId), state); }
export function getUserState(tgId) { return userState.get(String(tgId)); }
export function clearUserState(tgId) { userState.delete(String(tgId)); }

export function setAdminState(tgId, state) { adminState.set(String(tgId), state); }
export function getAdminState(tgId) { return adminState.get(String(tgId)); }
export function clearAdminState(tgId) { adminState.delete(String(tgId)); }

export function setLock(tgId, lock) { lockByUser.set(String(tgId), lock); }
export function getLock(tgId) { return lockByUser.get(String(tgId)); }
export function clearLock(tgId) { lockByUser.delete(String(tgId)); }
