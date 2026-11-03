export const DEFAULT_CONFIG = {
  assets: [
    { id: "XAU", label: "黄金 XAU/USD", kind: "goldapi", symbol: "XAU", lower: 3800, upper: 4200, enabled: true },
    { id: "BTC", label: "比特币 BTC/USD", kind: "goldapi", symbol: "BTC", lower: 80000, upper: 100000, enabled: true },
    { id: "SNDK", label: "闪迪 SNDK", kind: "alpaca", symbol: "SNDK", lower: 180, upper: 220, enabled: true }
  ]
};

export function validateConfig(value) {
  if (!value || !Array.isArray(value.assets) || value.assets.length < 1 || value.assets.length > 20) {
    throw new Error("assets 必须包含 1–20 个标的");
  }
  const ids = new Set();
  return { assets: value.assets.map((item) => {
    if (!item || typeof item !== "object") throw new Error("标的格式错误");
    const id = String(item.id || "").trim().toUpperCase();
    const label = String(item.label || "").trim();
    const symbol = String(item.symbol || "").trim().toUpperCase();
    if (!/^[A-Z0-9._-]{1,20}$/.test(id) || ids.has(id)) throw new Error(`标的 ID 重复或无效：${id}`);
    if (!label || label.length > 60) throw new Error(`${id} 的名称无效`);
    if (!/^[A-Z0-9.]{1,20}$/.test(symbol)) throw new Error(`${id} 的代码无效`);
    if (!(["goldapi", "alpaca"].includes(item.kind))) throw new Error(`${id} 的数据源无效`);
    if (item.kind === "goldapi" && !["XAU", "XAG", "XPT", "XPD", "HG", "BTC", "ETH"].includes(symbol)) throw new Error(`${id} 不受 Gold API 支持`);
    const lower = parseBound(item.lower, id);
    const upper = parseBound(item.upper, id);
    if (lower !== null && upper !== null && lower >= upper) throw new Error(`${id} 的下限必须小于上限`);
    ids.add(id);
    return { id, label, kind: item.kind, symbol, lower, upper, enabled: item.enabled !== false };
  }) };
}

function parseBound(raw, id) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${id} 的价格必须是大于零的数字`);
  return n;
}

export function zoneFor(price, asset) {
  if (asset.lower !== null && price <= asset.lower) return "low";
  if (asset.upper !== null && price >= asset.upper) return "high";
  return "inside";
}

export function isFresh(timestamp, now, maxAgeMs) {
  const then = Date.parse(timestamp);
  return Number.isFinite(then) && now - then >= -60_000 && now - then <= maxAgeMs;
}

export function formatAlert(asset, quote, zone) {
  const line = zone === "low" ? `已触及下限 ${asset.lower}` : `已触及上限 ${asset.upper}`;
  return `📈 区间预警：${asset.label} (${asset.symbol})\n现价：${quote.price} USD\n${line}\n数据源：${quote.source}\n报价时间：${quote.timestamp}`;
}
