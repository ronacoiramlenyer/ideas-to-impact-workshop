// From Ideas to Impact: tiny backend. Phones post answers, the presenter reads them.
//
// Live updates use hibernating WebSockets: each phone opens ONE connection and the
// Durable Object pushes the current question whenever it changes. That keeps a
// 40-phone, 2-hour session at a few thousand requests instead of ~144,000 polls
// (the Workers Free plan allows 100,000 requests per day). Phones fall back to slow
// polling of GET /api/live only if their WebSocket cannot connect.
import PAGE from "../public/index.html";

const rnd = (n) => { const r = new Uint32Array(1); crypto.getRandomValues(r); return r[0] % n; };
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const MAX = 8000;
const CID = /^[a-z0-9]{4,40}$/i;
const PID = /^[a-z0-9]{1,20}@[a-z0-9]{1,20}$/i; // question id: base@time36
const TEAM_COUNT = 17; // house names live in public/index.html (TEAMS): 9 Great Houses first, then 8 more
const TEAM_CAP = 5;    // default most members per house; the presenter can change it (1 to 40)
// Houses in use start at 0 and are set when the presenter taps Assign houses (people ÷ members per house).
const MAX_BRGY = 12;   // most barangays the presenter can list
// Participating barangays (South Caloocan). The presenter can edit this list on Home.
const DEFAULT_BRGYS = ["Barangay 38", "Barangay 39", "Barangay 40", "Barangay 42", "Barangay 45", "Barangay 97"];

export class Session {
  constructor(state) {
    this.state = state;
    this.s = state.storage;
    // Keep-alive pings are answered without waking the object (no request billed).
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async rev() { return (await this.s.get("rev")) ?? 0; }
  async cap() { return (await this.s.get("cap")) ?? TEAM_CAP; }
  async houses() { return Math.min((await this.s.get("hin")) ?? 0, TEAM_COUNT); } // houses in use; 0 = not assigned yet (key "hin": older versions stored "houses")
  async reg() { return (await this.s.get("reg")) ?? "open"; }
  async mode() { return (await this.s.get("mode")) ?? "mix"; } // "mix" barangays in each house, or "same" barangay per house
  async brgys() { return (await this.s.get("brgys")) ?? DEFAULT_BRGYS; }
  async settings() { return { cap: await this.cap(), houses: await this.houses(), barangays: await this.brgys(), reg: await this.reg(), mode: await this.mode(), tables: await this.tables() }; }
  async tables() { return (await this.s.get("tables")) ?? {}; } // physical table per house, set by the presenter

  // Late registrant (houses already assigned): a house in use with room, preferring the fewest people from the
  // same barangay, then the emptiest, then random. If every house is full, open the next house.
  async assign(cid, brgy) {
    const cap = await this.cap(), mode = await this.mode(), total = {}, same = {};
    let n = await this.houses();
    for (const [k, v] of await this.s.list({ prefix: "p:" })) {
      if (k === "p:" + cid || !v || !v.team) continue;
      total[v.team] = (total[v.team] || 0) + 1;
      if (v.barangay === brgy) same[v.team] = (same[v.team] || 0) + 1;
    }
    let best = [], key = null;
    for (let t = 1; t <= n; t++) {
      if ((total[t] || 0) >= cap) continue;
      // "same": only houses made up entirely of this barangay; key = [0, size] so the emptiest wins
      if (mode === "same" && (!total[t] || same[t] !== total[t])) continue;
      if (mode === "same") { const k = [0, total[t]]; if (!key || k[1] < key[1]) { key = k; best = [t]; } else if (k[1] === key[1]) best.push(t); continue; }
      const k = [same[t] || 0, total[t] || 0];
      if (!key || k[0] < key[0] || (k[0] === key[0] && k[1] < key[1])) { key = k; best = [t]; }
      else if (k[0] === key[0] && k[1] === key[1]) best.push(t);
    }
    if (!best.length) {
      if (n >= TEAM_COUNT) return 0;
      n += 1; await this.s.put("hin", n); return n;
    }
    return best[rnd(best.length)];
  }

  // Presenter taps "Assign houses". First time: open just enough houses for everyone registered
  // (people ÷ members per house, rounded up), then deal people out barangay by barangay so each house
  // mixes barangays and sizes differ by at most one. Later taps only place people without a house.
  async assignAll() {
    const cap = await this.cap(), docs = [...(await this.s.list({ prefix: "p:" }))];
    const waiting = docs.filter(([, v]) => v && !v.team);
    let n = await this.houses(), placed = 0;
    if (!waiting.length) return { houses: n, placed, waiting: 0 };
    if (!n && (await this.mode()) === "same") {
      // One barangay per house: each barangay gets ceil(people / cap) houses, filled evenly.
      const list = await this.brgys(), byB = {};
      for (const d of shuffle(waiting)) (byB[d[1].barangay] = byB[d[1].barangay] || []).push(d);
      const names = Object.keys(byB).sort((a, b) => (list.indexOf(a) + 1 || 99) - (list.indexOf(b) + 1 || 99));
      const put = {};
      for (const b of names) {
        const g = byB[b], k = Math.ceil(g.length / cap);
        if (n + k > TEAM_COUNT) break; // not enough house names left: raise members per house
        g.forEach(([key, v], i) => { put[key] = { ...v, team: n + 1 + (i % k) }; placed++; });
        n += k;
      }
      put.hin = n;
      await this.s.put(put);
    } else if (!n) {
      n = Math.min(TEAM_COUNT, Math.max(1, Math.ceil(docs.length / cap)));
      const byB = {};
      for (const d of shuffle(waiting)) (byB[d[1].barangay] = byB[d[1].barangay] || []).push(d);
      const order = shuffle(Object.keys(byB)).flatMap((k) => byB[k]);
      const start = rnd(n), size = {}, put = {};
      order.forEach(([k, v], i) => {
        let t = ((start + i) % n) + 1, tries = 0;
        while ((size[t] || 0) >= cap && tries++ < n) t = (t % n) + 1;
        if ((size[t] || 0) >= cap) return; // more people than houses can hold
        size[t] = (size[t] || 0) + 1; put[k] = { ...v, team: t }; placed++;
      });
      put.hin = n;
      await this.s.put(put);
    } else {
      for (const [k, v] of shuffle(waiting)) {
        const t = await this.assign(k.slice(2), v.barangay);
        if (!t) break;
        await this.s.put(k, { ...v, team: t }); placed++;
      }
      n = await this.houses();
    }
    return { houses: n, placed, waiting: waiting.length - placed };
  }

  async placeAndNotify() {
    const r = await this.assignAll();
    await this.s.put("rev", (await this.rev()) + 1);
    await this.broadcast({ live: false });
    for (const ws of this.state.getWebSockets("phone")) { try { ws.send('{"me":1}'); } catch (e) {} } // phones fetch their house
    return r;
  }

  // Members per house, optionally leaving one participant out.
  async counts(exceptCid) {
    const c = {};
    for (const [k, v] of await this.s.list({ prefix: "p:" })) if (k !== "p:" + exceptCid && v && v.team) c[v.team] = (c[v.team] || 0) + 1;
    return c;
  }
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
    if (u.pathname === "/teams") return J({ ...(await this.settings()), counts: await this.counts() });
    if (u.pathname === "/settings") {
      const b = await req.json();
      if (b.cap != null) await this.s.put("cap", b.cap);
      if (b.reg != null) await this.s.put("reg", b.reg);
      let assigned = null;
      if (b.reg === "closed") assigned = await this.placeAndNotify(); // houses are assigned when registration closes
      if (b.mode != null) await this.s.put("mode", b.mode);
      if (b.barangays != null) await this.s.put("brgys", b.barangays);
      if (b.tables != null) {
        await this.s.put("tables", b.tables);
        for (const ws of this.state.getWebSockets("phone")) { try { ws.send('{"me":1}'); } catch (e) {} } // phones refresh their table
      }
      return J({ ok: true, ...(await this.settings()), assigned });
    }
    if (u.pathname === "/assign") {
      if ((await this.reg()) !== "closed") return J({ error: "close registration first" }, 409);
      return J({ ok: true, ...(await this.placeAndNotify()) });
    }
    if (u.pathname === "/me") {
      const b = await req.json();
      // The server picks the house. Once someone has a house it never changes from the phone.
      const before = await this.s.get("p:" + b.cid);
      if (before) b.doc.team = before.team || 0; // registered people keep their house (or keep waiting for one)
      else {
        if ((await this.reg()) === "closed") return J({ error: "registration closed" }, 423);
        const list = await this.brgys();
        if (list.length && !list.includes(b.doc.barangay)) return J({ error: "unknown barangay" }, 400);
        b.doc.team = 0; // everyone waits; houses are assigned when the presenter closes registration
      }
      await this.s.put({ ["p:" + b.cid]: b.doc, rev: (await this.rev()) + 1 });
      await this.broadcast({ live: false });
      return J({ ok: true, team: b.doc.team });
    }
    if (u.pathname === "/responses") {
      const m = await this.s.list({ prefix: "p:" });
      return J([...m].map(([k, v]) => ({ id: k.slice(2), data: v })));
    }
    if (u.pathname === "/clear") {
      const rev = (await this.rev()) + 1, epoch = (await this.epoch()) + 1, set = await this.settings();
      await this.s.deleteAll();
      await this.s.put({ rev, epoch, cap: set.cap, brgys: set.barangays, mode: set.mode, tables: set.tables }); // cap, barangays, grouping, tables survive; houses and registration reset
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
  const team = Number(d.team) || 0; // 0 = not placed yet; the server assigns the house
  if (typeof d.name !== "string" || !d.name.trim() || !Number.isInteger(team) || team < 0 || team > TEAM_COUNT) return null;
  if (typeof d.barangay !== "string" || !d.barangay.trim() || d.barangay.length > 60) return null;
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
  const doc = { name: d.name.trim().slice(0, 40), barangay: d.barangay.trim(), team, answers: out, joinedAt: Number(d.joinedAt) || Date.now() };
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
      if (path === "/teams" && req.method === "GET") return call("/teams");
      if ((path === "/settings" || path === "/cap") && req.method === "POST") {
        if (!host) return J({ error: "forbidden" }, 403);
        const b = JSON.parse(await req.text()) || {}, out = {};
        if (b.cap != null) { const v = Number(b.cap); if (!Number.isInteger(v) || v < 1 || v > 40) return J({ error: "bad request" }, 400); out.cap = v; }
        if (b.reg != null) { if (b.reg !== "open" && b.reg !== "closed") return J({ error: "bad request" }, 400); out.reg = b.reg; }
        if (b.mode != null) { if (b.mode !== "mix" && b.mode !== "same") return J({ error: "bad request" }, 400); out.mode = b.mode; }
        if (b.tables != null) {
          if (typeof b.tables !== "object" || Array.isArray(b.tables)) return J({ error: "bad request" }, 400);
          const t = {};
          for (const [k, v] of Object.entries(b.tables)) {
            const n = Number(k);
            if (!Number.isInteger(n) || n < 1 || n > TEAM_COUNT || typeof v !== "string") return J({ error: "bad request" }, 400);
            if (v.trim()) t[n] = v.trim().slice(0, 24);
          }
          out.tables = t;
        }
        if (b.barangays != null) {
          if (!Array.isArray(b.barangays) || b.barangays.length > MAX_BRGY) return J({ error: "bad request" }, 400);
          const list = [...new Set(b.barangays.map((x) => String(x).trim().slice(0, 60)).filter(Boolean))];
          out.barangays = list;
        }
        return call("/settings", { method: "POST", body: JSON.stringify(out) });
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
      if (path === "/assign" && req.method === "POST") return host ? call("/assign", { method: "POST" }) : J({ error: "forbidden" }, 403);
      if (path === "/responses" && req.method === "GET") return host ? call("/responses") : J({ error: "forbidden" }, 403);
      if (path === "/clear" && req.method === "POST") return host ? call("/clear", { method: "POST" }) : J({ error: "forbidden" }, 403);
    } catch (e) { return J({ error: "bad request" }, 400); }
    return J({ error: "not found" }, 404);
  },
};
