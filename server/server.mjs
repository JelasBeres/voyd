// VOYD site server: serves ../site, answers "Ask the voyd" chat questions with Claude,
// runs the voyd CLI's server side (holder access, the agent, audit, roast, ship → /s/<name>/)
// and the owner panel (/admin): the $VOYD contract address, buyback & burn, owner CLI codes, shipped sites.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { ethers } from "ethers";
import { createBurn } from "./burn.mjs";
import { createAccess } from "./access.mjs";
import { agentTurn, buildPage, auditReport, roastSite, Busy } from "./ai.mjs";
import { auditFacts, fetchPage, createSites, SITE_MIME } from "./tools.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(here, "../site");
// data/ sits next to site/ and server/ so deploys never touch it
const DATA = path.resolve(process.env.DATA_DIR || path.join(here, "../data")), SETTINGS = path.join(DATA, "settings.json");
let settings = {}; try { settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8")) || {}; } catch {}
const tokenAddr = () => settings.token || "";
function saveSettings() { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(SETTINGS + ".tmp", JSON.stringify(settings, null, 1), { mode: 0o600 }); fs.renameSync(SETTINGS + ".tmp", SETTINGS); }
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { chainId: 4663, name: "robinhood" }, { staticNetwork: true });
const burn = createBurn({ dir: DATA, provider, token: tokenAddr });
const access = createAccess({ dir: DATA, token: tokenAddr });
const sites = createSites(DATA);
const PORT = +(process.env.PORT || 4200);
const MODEL = "claude-opus-5-5";
const client = new Anthropic();

const SYSTEM = `You are "the voyd", the assistant on the VOYD website. Answer visitors' questions in English, in a calm, confident voice with a little mystery. Keep answers short: usually 2 to 6 sentences or a few bullets. Use plain text with light markdown (**bold**, \`code\`, short lists). Never use headings.

You answer two kinds of questions:
1. How VOYD works and how to use it (your main job).
2. Anything else the visitor asks: coding, crypto basics, writing, general knowledge. Help them properly, then, only where it fits naturally, connect it back to what VOYD could build.

# What VOYD is
VOYD is an AI agent that lives in your terminal. You say one sentence describing what you want and it writes the project into your folder, then ships it to a live link. Tagline: "Speak into the voyd. Something real comes back."

# What works today (Phase 01)
On the website: anyone can type one sentence in the hero terminal and VOYD AI builds a real web page live (a few free builds a day).
In the terminal, for $VOYD holders:
- Install: \`npm i -g https://voydagent.com/voyd-agent.tgz\` (needs Node 18+).
- Get access: hold at least 0.1% of the $VOYD supply, go to voydagent.com → "Get access", connect the wallet, sign one free message, get a code. Then \`voyd login <code>\`. One code per wallet, locked to one device; if you sell, it stops working.
- \`voyd "<one sentence>"\` builds the project in the current folder (the agent reads and writes files only there). Plain \`voyd\` opens a session to keep iterating.
- \`voyd preview\` serves the folder locally and opens the browser.
- \`voyd ship <name>\` uploads the folder (static sites, up to 8 MB) to a live link: voydagent.com/s/<name>.
- \`voyd audit <contract address>\` reads a Robinhood Chain token from the chain (owner, risky functions, proxy, Pons status, holders, verified source) and gives a 0-100 score. Not financial advice.
- \`voyd roast <url>\` gives a brutally honest review of any public website; \`voyd fix\` then improves the site in your folder using that roast.
- \`voyd brand "<project>"\` writes 3 SVG logo concepts, an X bio, DEX info and a palette into ./brand.
- \`voyd x "<project>"\` writes X content into ./x: profile and bios, a launch thread, 10 posts with hooks, and 3 post images to screenshot.
- Full step-by-step tutorial: voydagent.com/docs. Point people there for detailed how-tos.

# Coming next (not live yet, say so clearly if asked)
- Phase 02: \`voyd launch\` (launch a token on Pons from the terminal) and \`voyd video\` (launch videos).
- Phase 03: \`voyd echo\` (posts burns, whales and milestones to X automatically), \`voyd mascot\` and \`voyd post\`.
- Phase 04: \`voyd remix\` (fork with royalties), \`voyd battle\`, a public gallery.
- The engine is VOYD AI, running on voydagent.com: no API key needed, holding $VOYD is the key. Limits per code per day: 300 agent steps, 40 audits + roasts, 30 ships.
- Higher holder tiers (Echo 0.5%, Voydwalker 1%) unlock those features as they ship.

# Daily Summon
Runs on X at @voydagent: holders reply with one sentence, the most-liked one gets built with VOYD and shipped live.

# $VOYD
Live on Robinhood Chain via the Pons launchpad. Holding 0.1% of supply unlocks the terminal agent. The team buys $VOYD back and burns it on-chain; every burn is listed on voydagent.com with its transaction.

# Honesty rules (important)
- Only the features under "What works today" are live. Everything under "Coming next" is not live yet; never say otherwise. Example names in the site's sample run ($FROG and similar) are examples.
- You do not know the $VOYD contract address, price, market cap or holder count. Never invent one. Tell people to only trust the address posted by @voydagent on X and to beware of fake tokens.
- VOYD has no Telegram. The official X account is @voydagent (https://x.com/voydagent): launches, the CA and updates are posted there.
- Never give financial advice or promise returns. You can explain how the burn and tiers work, not whether to buy.
- If you don't know something about VOYD, say so plainly instead of guessing.
- If asked what AI or model powers you, say you are VOYD AI. Don't name other AI companies or models.
- VOYD is not affiliated with Robinhood. Say "live on Robinhood Chain", never "listed on Robinhood".`;

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json", ".mp4": "video/mp4", ".txt": "text/plain; charset=utf-8", ".tgz": "application/gzip" };
const LIMIT = { build: +process.env.BUILDS_PER_IP || 3, buildsAll: +process.env.BUILDS_PER_DAY || 150, agent: +process.env.AGENT_CALLS_PER_DAY || 300, tool: +process.env.TOOL_CALLS_PER_DAY || 40 };

const ipOf = (req) => String(req.headers["x-real-ip"] || req.socket.remoteAddress || "?");
// a light per-IP limit so the chat can't be drained
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, list = (hits.get(ip) || []).filter((t) => now - t < win);
  list.push(now); hits.set(ip, list);
  return list.length > 30;
}
// daily quotas (UTC day), in memory
const quota = new Map();
function take(kind, who, max) {
  const day = new Date().toISOString().slice(0, 10), k = `${day}|${kind}|${who}`, n = quota.get(k) || 0;
  if (n >= max) return false;
  quota.set(k, n + 1);
  if (quota.size > 50_000) for (const key of quota.keys()) if (!key.startsWith(day)) quota.delete(key);
  return true;
}

function readBody(req, max = 40_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > max) { reject(Object.assign(new Error("Request is too large."), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function jsonBody(req, max) { try { return JSON.parse((await readBody(req, max)) || "{}"); } catch (e) { throw e.code ? e : Object.assign(new Error("Bad request."), { code: 400 }); } }
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };

// keep only well-formed, alternating turns that start with the user
function cleanHistory(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const m of raw.slice(-16)) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") continue;
    const content = m.content.trim().slice(0, 2000);
    if (!content) continue;
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += "\n\n" + content;
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out.length && out[out.length - 1].role === "user" ? out : null;
}

async function ask(req, res) {
  if (limited(ipOf(req))) { res.writeHead(429, { "content-type": "text/plain" }); return res.end("The voyd needs a moment. Try again in a few minutes."); }
  let messages;
  try { messages = cleanHistory(JSON.parse(await readBody(req)).messages); } catch { messages = null; }
  if (!messages) { res.writeHead(400, { "content-type": "text/plain" }); return res.end("Say something first."); }

  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" });
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }, { type: "text", text: tokenAddr() ? `Launch status: $VOYD is live on Robinhood Chain. The official contract address (CA) is ${tokenAddr()}. You may share this exact address when asked, and remind people it is also posted by @voydagent on X.` : "Launch status: $VOYD has not launched yet and there is no contract address. Anyone sharing a CA right now is not VOYD." }],
      messages,
    });
    req.on("close", () => stream.abort());
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") res.write(event.delta.text);
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") res.write("\n\nThe voyd can't help with that one. Ask it something else.");
    else if (final.stop_reason === "max_tokens") res.write("…");
  } catch (err) {
    if (err instanceof Anthropic.APIUserAbortError) return;
    if (err instanceof Anthropic.RateLimitError) res.write("\n\nToo many people are speaking at once. Try again in a moment.");
    else if (err instanceof Anthropic.AuthenticationError) { console.error("[ask] invalid API key"); res.write("\n\nThe voyd is offline right now."); }
    else if (err instanceof Anthropic.APIError) { console.error(`[ask] API error ${err.status}:`, err.message); res.write("\n\nThe voyd went quiet. Try again."); }
    else { console.error("[ask]", err); res.write("\n\nThe voyd went quiet. Try again."); }
  }
  res.end();
}

// streams model text to the client; errors after the first byte end the stream with a marker line
async function streamText(req, res, run) {
  const ac = new AbortController(); res.on("close", () => ac.abort());
  let started = false;
  const start = () => { if (!started) { started = true; res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" }); } };
  try {
    await run((t) => { start(); res.write(t); }, ac.signal);
    if (!started) return json(res, 502, { error: "VOYD AI returned nothing. Try again." });
    res.end();
  } catch (e) {
    if (ac.signal.aborted) return;
    if (!started) return json(res, typeof e.code === "number" ? e.code : 503, { error: e instanceof Busy || typeof e.code === "number" ? e.message : "VOYD AI could not answer. Try again." });
    res.end("\n[stopped: " + (e.message || "error") + "]");
  }
}

// the CLI sends its whole conversation each turn, exactly as the model produced it; check its shape
const BLOCKS = new Set(["text", "tool_use", "tool_result", "thinking", "redacted_thinking", "fallback"]);
function validMessages(m) {
  if (!Array.isArray(m) || !m.length || m.length > 400 || m[0].role !== "user") return false;
  return m.every((x) => (x.role === "user" || x.role === "assistant") && (typeof x.content === "string" || (Array.isArray(x.content) && x.content.every((b) => BLOCKS.has(b?.type)))));
}

function isAdmin(req) {
  const want = Buffer.from(process.env.VOYD_ADMIN_KEY || ""), got = Buffer.from(String(req.headers["x-admin-key"] || ""));
  return want.length >= 16 && got.length === want.length && timingSafeEqual(got, want);
}
const adminTries = new Map();
let pub = { at: 0, v: null };
const holderOf = (req) => access.check(req.headers["x-voyd-code"], req.headers["x-voyd-device"]);

async function api(req, res, pathname) {
  const ip = ipOf(req);
  // public: the CA and the burn tally for the website
  if (pathname === "/api/token") {
    if (Date.now() - pub.at > 60_000) pub = { at: Date.now(), v: await burn.publicView() };
    return json(res, 200, pub.v);
  }
  if (pathname === "/api/health") return json(res, 200, { ok: true, name: "VOYD" });
  if (pathname === "/api/access/info") return json(res, 200, access.info());
  if (pathname === "/api/access/me") return json(res, 200, await holderOf(req));
  if (req.method !== "POST") return json(res, 405, { error: "POST only." });

  // holders sign once on the website and get their one CLI access code
  if (pathname === "/api/access/claim") {
    if (!take("claim", ip, 30)) return json(res, 429, { error: "Too many tries. Wait a bit." });
    return json(res, 200, await access.claim(await jsonBody(req, 4_000)));
  }

  // the website's live builder: free, a few per visitor per day
  if (pathname === "/api/build") {
    const b = await jsonBody(req, 4_000), prompt = String(b.prompt || "").trim();
    if (prompt.length < 4 || prompt.length > 400) return json(res, 400, { error: "Say it in 4 to 400 characters." });
    if (!take("build-all", "all", LIMIT.buildsAll)) return json(res, 429, { error: "The voyd built a lot today. Try again tomorrow, or use the CLI." });
    if (!take("build", ip, LIMIT.build)) return json(res, 429, { error: `That's ${LIMIT.build} free builds today. Hold $VOYD and keep going in your terminal.` });
    return streamText(req, res, (onText, signal) => buildPage(prompt, onText, signal));
  }

  // CLI commands: holders only
  if (pathname === "/api/agent") {
    const who = await holderOf(req);
    const b = await jsonBody(req, 4_000_000);
    if (!validMessages(b.messages)) return json(res, 400, { error: "Bad conversation." });
    if (!take("agent", who.wallet, LIMIT.agent)) return json(res, 429, { error: "Daily limit reached for this code. It resets at 00:00 UTC." });
    const ac = new AbortController(); res.on("close", () => ac.abort());
    try { return json(res, 200, await agentTurn(b.messages, ac.signal)); }
    catch (e) { if (!ac.signal.aborted) return json(res, 503, { error: e instanceof Busy ? e.message : "VOYD AI could not answer. Try again." }); }
    return;
  }
  if (pathname === "/api/audit" || pathname === "/api/roast") {
    const who = await holderOf(req), b = await jsonBody(req, 4_000);
    if (!take("tool", who.wallet, LIMIT.tool)) return json(res, 429, { error: "Daily limit reached for audits and roasts. It resets at 00:00 UTC." });
    if (pathname === "/api/audit") { const facts = await auditFacts(provider, b.address); return streamText(req, res, (onText, signal) => auditReport(facts, onText, signal)); }
    const page = await fetchPage(String(b.url || "").trim());
    return streamText(req, res, (onText, signal) => roastSite(page.url, page.html, onText, signal));
  }
  if (pathname === "/api/ship") {
    const who = await holderOf(req);
    if (!take("ship", who.wallet, 30)) return json(res, 429, { error: "30 ships a day. It resets at 00:00 UTC." });
    const b = await jsonBody(req, 12_000_000);
    const r = await sites.ship(who, b.name, b.files);
    const host = String(req.headers.host || "voydagent.com"), proto = req.headers["x-forwarded-proto"] || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
    return json(res, 200, { ...r, url: `${proto}://${host}${r.path}` });
  }

  // owner panel
  if (!pathname.startsWith("/api/admin/")) return json(res, 404, { error: "Not found." });
  const now = Date.now(), tries = (adminTries.get(ip) || []).filter((t) => now - t < 15 * 60_000);
  if (tries.length >= 20) return json(res, 429, { error: "Too many wrong keys. Wait 15 minutes." });
  if (!isAdmin(req)) { tries.push(now); adminTries.set(ip, tries); return json(res, 401, { error: "Wrong admin key." }); }
  const b = await jsonBody(req, 4_000);
  try {
    if (pathname === "/api/admin/token") {
      const t = String(b.token || "").trim();
      if (t && !ethers.isAddress(t)) return json(res, 400, { error: "That is not a contract address." });
      if (t && (await provider.getCode(t)) === "0x") return json(res, 400, { error: "No contract at that address on Robinhood Chain." });
      settings.token = t ? ethers.getAddress(t) : ""; saveSettings(); pub.at = 0;
    }
    if (pathname === "/api/admin/key") await burn.setKey(b.privateKey);
    if (pathname === "/api/admin/burn") { const done = await burn.run(b.usd); pub.at = 0; return json(res, 200, { ...(await burn.view()), done }); }
    if (pathname === "/api/admin/burn-held") { const done = await burn.burnHeld(); pub.at = 0; return json(res, 200, { ...(await burn.view()), done }); }
    if (pathname === "/api/admin/code") return json(res, 200, await access.ownerCode(req.headers["x-admin-key"], b.label));
    if (pathname === "/api/admin/sites") { if (b.remove) await sites.remove(String(b.remove)); return json(res, 200, { sites: await sites.list() }); }
    return json(res, 200, await burn.view());
  } catch (e) {
    if (typeof e.code === "number") return json(res, e.code, { error: e.message });
    console.error("[admin]", e.shortMessage || e.message);
    return json(res, 502, { error: e.shortMessage || e.reason || "The chain refused it. Try again." });
  }
}

function sendFile(req, res, file, headers) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "content-length": st.size, "x-content-type-options": "nosniff", ...headers });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}
function serveStatic(req, res) {
  let p; try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400); return res.end(); }
  // shipped sites: run in a sandbox (an opaque origin), so they can never touch voydagent.com itself
  const m = p.match(/^\/s\/([a-z0-9-]{3,32})(\/.*)?$/);
  if (m) {
    if (!m[2]) { res.writeHead(301, { location: `/s/${m[1]}/` }); return res.end(); }
    let sp = m[2]; if (sp.endsWith("/")) sp += "index.html";
    const base = path.join(sites.root, m[1]), file = path.resolve(base, "." + sp);
    if (!file.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
    return sendFile(req, res, file, { "content-type": SITE_MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads", "cache-control": "public, max-age=60", "x-robots-tag": "noindex" });
  }
  if (p === "/admin" || p === "/admin/") p = "/admin.html";
  if (p === "/docs" || p === "/docs/") p = "/docs.html";
  if (p.endsWith("/")) p += "index.html";
  const file = path.resolve(SITE, "." + p);
  if (!file.startsWith(SITE + path.sep)) { res.writeHead(403); return res.end(); }
  const ext = path.extname(file).toLowerCase();
  sendFile(req, res, file, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": ext === ".html" || ext === ".tgz" ? "no-cache" : "public, max-age=3600", ...(p === "/admin.html" ? { "x-robots-tag": "noindex", "x-frame-options": "DENY" } : {}) });
}

http.createServer((req, res) => {
  if (req.url.startsWith("/api/ask")) {
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); return res.end(); }
    return ask(req, res);
  }
  const pathname = new URL(req.url, "http://x").pathname;
  if (pathname.startsWith("/api/")) return api(req, res, pathname).catch((e) => {
    if (["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "NETWORK_ERROR", "TIMEOUT", "SERVER_ERROR"].includes(e.code)) e = Object.assign(new Error("Couldn't reach Robinhood Chain right now. Try again in a minute."), { code: 503 });
    const known = typeof e.code === "number";
    if (!known) console.error(e);
    if (!res.headersSent) json(res, known ? e.code : 500, { error: known ? e.message : "Something broke on our side." }); else res.end();
  });
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
  serveStatic(req, res);
}).listen(PORT, "127.0.0.1", () => console.log(`VOYD on http://localhost:${PORT}`));
