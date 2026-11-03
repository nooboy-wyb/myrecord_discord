import { DEFAULT_CONFIG, validateConfig, zoneFor, isFresh, formatAlert } from "./core.js";
import { dashboard } from "./dashboard.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

async function getConfig(env) {
  const stored = await env.ALERTS_KV.get("config", "json");
  return validateConfig(stored ?? DEFAULT_CONFIG);
}

function authorized(request, env) {
  const expected = env.ADMIN_TOKEN;
  return typeof expected === "string" && expected.length >= 24 && request.headers.get("authorization") === `Bearer ${expected}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`行情接口 HTTP ${response.status}`);
  return response.json();
}

async function getQuotes(assets, env) {
  const now = Date.now();
  const work = assets.map(async (asset) => {
    try {
      if (asset.kind === "goldapi") {
        const data = await fetchJson(`https://api.gold-api.com/price/${asset.symbol}`);
        const price = Number(data.price);
        if (!Number.isFinite(price) || price <= 0 || !data.updatedAt) throw new Error("报价字段无效");
        return { id: asset.id, price, timestamp: data.updatedAt, source: "Gold API", fresh: isFresh(data.updatedAt, now, 120_000) };
      }
      if (!env.ALPACA_KEY_ID || !env.ALPACA_SECRET_KEY) throw new Error("未配置 Alpaca API 密钥");
      const data = await fetchJson(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(asset.symbol)}/trades/latest?feed=iex`, {
        headers: { "APCA-API-KEY-ID": env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY }
      });
      const trade = data.trade;
      const price = Number(trade?.p);
      if (!Number.isFinite(price) || price <= 0 || !trade?.t) throw new Error("IEX 暂无有效成交价");
      return { id: asset.id, price, timestamp: trade.t, source: "Alpaca IEX", fresh: isFresh(trade.t, now, 15 * 60_000) };
    } catch (error) {
      return { id: asset.id, price: null, timestamp: null, source: asset.kind === "alpaca" ? "Alpaca IEX" : "Gold API", fresh: false, error: String(error.message || error) };
    }
  });
  return Promise.all(work);
}

async function sendAstrBot(env, umo, message) {
  if (!env.ASTRBOT_URL || !env.ASTRBOT_API_KEY || !umo) return { ok: false, error: "AstrBot 地址、密钥或 UMO 未配置" };
  let base;
  try { base = new URL(env.ASTRBOT_URL); } catch { return { ok: false, error: "AstrBot URL 无效" }; }
  if (base.protocol !== "https:") return { ok: false, error: "AstrBot 必须使用 HTTPS" };
  try {
    const response = await fetch(new URL("/api/v1/im/message", base), {
      method: "POST",
      headers: { authorization: `Bearer ${env.ASTRBOT_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ umo, message }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return { ok: false, error: `AstrBot HTTP ${response.status}` };
    const body = await response.json().catch(() => null);
    if (body && (body.success === false || body.code && body.code !== 0 && body.code !== 200)) return { ok: false, error: "AstrBot 拒绝了消息" };
    return { ok: true };
  } catch (error) { return { ok: false, error: String(error.message || error) }; }
}

export async function checkAll(env) {
  const config = await getConfig(env);
  const quotes = await getQuotes(config.assets, env);
  const results = await Promise.all(config.assets.map(async (asset, index) => {
    const quote = quotes[index];
    if (!asset.enabled || (asset.lower === null && asset.upper === null)) return { id: asset.id, skipped: "未启用或未设置区间" };
    if (quote.error || !quote.fresh) return { id: asset.id, error: quote.error || "报价已过期，跳过预警" };
    const zone = zoneFor(quote.price, asset);
    const key = `state:${asset.id}`;
    const signature = JSON.stringify([asset.kind, asset.symbol, asset.lower, asset.upper]);
    const old = await env.ALERTS_KV.get(key, "json");
    const state = old?.signature === signature && old?.zone === zone ? old : { signature, zone, delivered: [] };
    if (zone === "inside") {
      if (!old || old.signature !== signature || old.zone !== zone) await env.ALERTS_KV.put(key, JSON.stringify(state));
      return { id: asset.id, zone };
    }
    const destinations = [ ["wechat", env.UMO_WECHAT], ["qq", env.UMO_QQ] ];
    const pending = destinations.filter(([name]) => !state.delivered.includes(name));
    const sent = await Promise.all(pending.map(async ([name, umo]) => ({ name, ...(await sendAstrBot(env, umo, formatAlert(asset, quote, zone))) })));
    for (const item of sent) if (item.ok) state.delivered.push(item.name);
    await env.ALERTS_KV.put(key, JSON.stringify(state));
    return { id: asset.id, zone, sent: sent.filter(x => x.ok).map(x => x.name), errors: sent.filter(x => !x.ok).map(x => `${x.name}: ${x.error}`) };
  }));
  return results;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response(dashboard, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" } });
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
    if (!url.pathname.startsWith("/api/")) return json({ error: "未找到" }, 404);
    if (!authorized(request, env)) return json({ error: "管理密钥错误或尚未配置" }, 401);
    try {
      if (request.method === "GET" && url.pathname === "/api/config") return json({ config: await getConfig(env) });
      if (request.method === "PUT" && url.pathname === "/api/config") {
        const config = validateConfig(await request.json());
        await env.ALERTS_KV.put("config", JSON.stringify(config));
        return json({ config });
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        const config = await getConfig(env);
        return json({ quotes: await getQuotes(config.assets, env) });
      }
      if (request.method === "POST" && url.pathname === "/api/check") return json({ results: await checkAll(env) });
      return json({ error: "未找到" }, 404);
    } catch (error) {
      const message = String(error.message || error);
      return json({ error: message }, message.includes("assets") || message.includes("无效") || message.includes("必须") ? 400 : 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkAll(env).then(results => console.log(JSON.stringify(results))).catch(error => console.error("检查失败", error)));
  }
};
