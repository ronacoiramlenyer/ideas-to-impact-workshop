// From Ideas to Impact: tiny backend. Phones post answers, the presenter reads them.
//
// Live updates use hibernating WebSockets: each phone opens ONE connection and the
// Durable Object pushes the current question whenever it changes. That keeps a
// 40-phone, 2-hour session at a few thousand requests instead of ~144,000 polls
// (the Workers Free plan allows 100,000 requests per day). Phones fall back to slow
// polling of GET /api/live only if their WebSocket cannot connect.
import PAGE from "../public/index.html";

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const MAX = 8000;
const CID = /^[a-z0-9]{4,40}$/i;
const PID = /^[a-z0-9]{1,20}@[a-z0-9]{1,20}$/i; // question id: base@time36

export class Session {
  constructor(state) {
    this.state = state;
    this.s = state.storage;
    // Keep-alive pings are answered without waking the object (no request billed).
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async rev() { return (await this.s.get("rev")) ?? 0; }
  // Goes up by one on every "Clear all answers", so phones know to forget what they kept locally.
  async epoch() { return (await this.s.get("epoch")) ?? 0; }

  // Push the live question to every socket; the presenter's sockets also get the answer revision.
  async broadcast({ live = true, rev = true } = {}) {
    const msg = {};
    if (live) { msg.live = (await this.s.get("live")) ?? null; msg.epoch = await this.epoch(); }
    if (rev) msg.rev = await this.rev();
    const all = JSON.stringify(msg), toPhones = live ? JSON.stringify({ live: msg.live, epoch: msg.epoch }) : null;
    for (const ws of this.state.getWebSockets()) {
      const host = this.state.getTags(ws).includes("host");
      const out = host ? all : toPhones;
      if (!out) continue;
      try { ws.send(out); } catch (e) { /* socket already closing */ }
    }
  }

  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/ws") {
      const pair = new WebSocketPair();
      const role = u.searchParams.get("role") === "host" ? "host" : "phone";
      this.state.acceptWebSocket(pair[1], [role]);
      const hello = { live: (await this.s.get("live")) ?? null, epoch: await this.epoch() };
      if (role === "host") hello.rev = await this.rev();
      pair[1].send(JSON.stringify(hello));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (u.pathname === "/live" && req.method === "GET") return J({ live: (await this.s.get("live")) ?? null, epoch: await this.epoch() });
    if (u.pathname === "/live") { await this.s.put("live", await req.json()); await this.broadcast({ rev: false }); return J({ ok: true }); }
    if (u.pathname === "/me" && req.method === "GET") return J((await this.s.get("p:" + u.searchParams.get("cid"))) ?? null);
    if (u.pathname === "/me") {
      const b = await req.json();
      await this.s.put({ ["p:" + b.cid]: b.doc, rev: (await this.rev()) + 1 });
      await this.broadcast({ live: false });
      return J({ ok: true });
    }
    if (u.pathname === "/responses") {
      const m = await this.s.list({ prefix: "p:" });
      return J([...m].map(([k, v]) => ({ id: k.slice(2), data: v })));
    }
    if (u.pathname === "/clear") {
      const rev = (await this.rev()) + 1, epoch = (await this.epoch()) + 1;
      await this.s.deleteAll();
      await this.s.put({ rev, epoch });
      await this.broadcast();
      return J({ ok: true });
    }
    return J({ error: "not found" }, 404);
  }

  // Clients only send "ping" (auto-answered above). Anything else is ignored.
  async webSocketMessage() {}
  async webSocketClose(ws, code) { try { ws.close(code, "bye"); } catch (e) {} }
  async webSocketError() {}
}

const int1to5 = (n) => Number.isInteger(n) && n >= 1 && n <= 5;

// An answer value must be one of the shapes the phone sends. Anything else is rejected,
// so nothing unexpected can ever reach the presenter's screen.
function cleanValue(v) {
  if (typeof v === "string") return v.length <= 300 ? v : null;
  if (typeof v === "number") return Number.isFinite(v) && Math.abs(v) < 1e9 ? v : null;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (typeof v.text !== "string" || v.text.length > 200 || !int1to5(v.occ) || !int1to5(v.imp)) return null;
    return { text: v.text, occ: v.occ, imp: v.imp };
  }
  return null;
}

function cleanDoc(d) {
  if (!d || typeof d !== "object") return null;
  const team = Number(d.team);
  if (typeof d.name !== "string" || !d.name.trim() || !Number.isInteger(team) || team < 1 || team > 8) return null;
  const answers = d.answers && typeof d.answers === "object" && !Array.isArray(d.answers) ? d.answers : {};
  const keys = Object.keys(answers);
  if (keys.length > 60) return null;
  const out = {};
  for (const k of keys) {
    const a = answers[k];
    if (!PID.test(k) || !a || typeof a !== "object") return null;
    const v = cleanValue(a.v);
    if (v === null) return null;
    out[k] = { v, t: Number(a.t) || 0 };
  }
  const doc = { name: d.name.trim().slice(0, 40), team, answers: out, joinedAt: Number(d.joinedAt) || Date.now() };
  return JSON.stringify(doc).length > MAX ? null : doc;
}

function cleanLive(t) {
  const b = JSON.parse(t);
  if (!b || typeof b !== "object") return null;
  return b;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      return new Response(req.method === "HEAD" ? null : PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
    }
    const stub = env.SESSION.get(env.SESSION.idFromName("main"));
    const host = !!env.PRESENTER_KEY && req.headers.get("x-key") === env.PRESENTER_KEY;
    const path = url.pathname.slice(4);
    const call = (p, init) => stub.fetch("https://do" + p, init);
    try {
      if (path === "/ws") {
        if (req.headers.get("upgrade") !== "websocket") return J({ error: "expected websocket" }, 426);
        // The socket only carries the public question and an answer counter, so no key is needed.
        return call("/ws?role=" + (url.searchParams.get("role") === "host" ? "host" : "phone"), { headers: req.headers });
      }
      if (path === "/live" && req.method === "GET") return call("/live");
      if (path === "/live" && req.method === "POST") {
        if (!host) return J({ error: "forbidden" }, 403);
        const t = await req.text(); if (t.length > MAX) return J({ error: "too big" }, 413);
        if (!cleanLive(t)) return J({ error: "bad request" }, 400);
        return call("/live", { method: "POST", body: t });
      }
      if (path === "/me" && req.method === "GET") {
        const cid = url.searchParams.get("cid") || "";
        if (!CID.test(cid)) return J(null);
        return call("/me?cid=" + cid);
      }
      if (path === "/me" && req.method === "POST") {
        const t = await req.text(); if (t.length > MAX) return J({ error: "too big" }, 413);
        const b = JSON.parse(t), doc = cleanDoc(b && b.doc);
        if (!CID.test((b && b.cid) || "") || !doc) return J({ error: "bad request" }, 400);
        return call("/me", { method: "POST", body: JSON.stringify({ cid: b.cid, doc }) });
      }
      if (path === "/responses" && req.method === "GET") return host ? call("/responses") : J({ error: "forbidden" }, 403);
      if (path === "/clear" && req.method === "POST") return host ? call("/clear", { method: "POST" }) : J({ error: "forbidden" }, 403);
    } catch (e) { return J({ error: "bad request" }, 400); }
    return J({ error: "not found" }, 404);
  },
};
