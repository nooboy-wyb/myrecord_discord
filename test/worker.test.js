import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig, zoneFor, isFresh } from "../src/core.js";
import { checkAll } from "../src/worker.js";

test("区间边界和配置校验", () => {
  const a = { id: "BTC", label: "BTC", kind: "goldapi", symbol: "BTC", lower: 90, upper: 110, enabled: true };
  assert.equal(zoneFor(90, a), "low");
  assert.equal(zoneFor(110, a), "high");
  assert.equal(zoneFor(100, a), "inside");
  assert.throws(() => validateConfig({ assets: [{ ...a, lower: 120 }] }), /下限/);
  assert.equal(isFresh(new Date(Date.now() - 180_000).toISOString(), Date.now(), 120_000), false);
});

test("越界只通知一次，回区间后重新布防；失败渠道重试", async () => {
  const memory = new Map();
  const kv = {
    async get(key) { return memory.has(key) ? JSON.parse(memory.get(key)) : null; },
    async put(key, value) { memory.set(key, value); }
  };
  await kv.put("config", JSON.stringify({ assets: [{ id: "BTC", label: "BTC", kind: "goldapi", symbol: "BTC", lower: 90, upper: 110, enabled: true }] }));
  const env = { ALERTS_KV: kv, ASTRBOT_URL: "https://bot.example.com", ASTRBOT_API_KEY: "secret", UMO_WECHAT: "wx", UMO_QQ: "qq" };
  let price = 120, qqFails = true;
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("gold-api")) return new Response(JSON.stringify({ price, updatedAt: new Date().toISOString() }), { status: 200 });
    const body = JSON.parse(options.body);
    sent.push(body.umo);
    if (body.umo === "qq" && qqFails) return new Response("error", { status: 500 });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  try {
    assert.deepEqual((await checkAll(env))[0].sent, ["wechat"]);
    qqFails = false;
    assert.deepEqual((await checkAll(env))[0].sent, ["qq"]);
    assert.deepEqual((await checkAll(env))[0].sent, []);
    price = 100;
    assert.equal((await checkAll(env))[0].zone, "inside");
    price = 120;
    assert.deepEqual((await checkAll(env))[0].sent, ["wechat", "qq"]);
    assert.deepEqual(sent, ["wx", "qq", "qq", "wx", "qq"]);
  } finally { globalThis.fetch = originalFetch; }
});
