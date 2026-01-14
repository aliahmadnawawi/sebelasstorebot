import fetch from "node-fetch";

const BASE = "https://app.pakasir.com";

function toIntAmount(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${x}`);
  return Math.trunc(n);
}

export async function pakasirCreateQris({ project, apiKey, orderId, amount }) {
  const payload = {
    project,
    order_id: orderId,
    amount: toIntAmount(amount),
    api_key: apiKey
  };

  const res = await fetch(`${BASE}/api/transactioncreate/qris`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Pakasir create failed: ${res.status} ${JSON.stringify(json)}`);
  return json.payment || json;
}

export async function pakasirDetail({ project, apiKey, orderId, amount }) {
  const url = new URL(`${BASE}/api/transactiondetail`);
  url.searchParams.set("project", project);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("order_id", orderId);
  url.searchParams.set("amount", String(toIntAmount(amount)));

  const res = await fetch(url.toString());
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Pakasir detail failed: ${res.status} ${JSON.stringify(json)}`);
  return json;
}
