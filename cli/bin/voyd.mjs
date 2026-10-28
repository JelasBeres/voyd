#!/usr/bin/env node
// voyd: speak one sentence into the voyd, something real comes back. The model runs on voydagent.com;
// files are read and written here, inside the folder you start it in, and nowhere else.
import { readFile, writeFile, readdir, stat, mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import http from "node:http";
import path from "node:path";
import { exec } from "node:child_process";

const VERSION = "1.1.0";
const SERVER = (process.env.VOYD_URL || "https://voydagent.com").replace(/\/$/, "");
const ROOT = process.cwd();
const HOME = path.join(os.homedir(), ".voyd"), CONF = path.join(HOME, "config.json"), DEVICE = path.join(HOME, "device");
const GET_CODE = `Get your access code at ${SERVER}/#access (hold $VOYD, connect your wallet), then run: voyd login <code>`;

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const hi = c("1;97"), dim = c("2"), bold = c("1"), red = c("31");
const out = (s = "") => process.stdout.write(s + "\n");
// light markdown for the terminal: **bold**, `code`, - bullets
const md = (t) => t.replace(/\*\*(.+?)\*\*/g, (_, x) => bold(x)).replace(/`([^`]+)`/g, (_, x) => hi(x)).replace(/^(\s*)[-*] /gm, "$1• ");

// a random id for this machine, made once; a code works on one device only
async function deviceId() {
  try { const d = (await readFile(DEVICE, "utf8")).trim(); if (/^[0-9a-f]{64}$/.test(d)) return d; } catch {}
  const d = randomBytes(32).toString("hex");
  await mkdir(HOME, { recursive: true, mode: 0o700 }); await writeFile(DEVICE, d, { mode: 0o600 });
  return d;
}
async function savedCode() { if (process.env.VOYD_CODE) return process.env.VOYD_CODE.trim(); try { return JSON.parse(await readFile(CONF, "utf8")).code || ""; } catch { return ""; } }
async function headers() {
  const code = await savedCode(); if (!code) throw new Error(GET_CODE);
  return { "content-type": "application/json", "user-agent": "voyd-agent/" + VERSION, "x-voyd-code": code, "x-voyd-device": await deviceId() };
}
async function post(p, body, timeout = 300_000) {
  let res; try { res = await fetch(SERVER + p, { method: "POST", headers: await headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) }); }
  catch (e) { throw new Error(e.message?.startsWith("Get your") ? e.message : "Can't reach the voyd. Check your connection."); }
  return res;
}
async function postJson(p, body, timeout) { const res = await post(p, body, timeout), j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(j.error || "The voyd could not answer."); return j; }
// streams a plain-text answer to the terminal; returns the full text
async function postStream(p, body) {
  const res = await post(p, body);
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "The voyd could not answer."); }
  const dec = new TextDecoder(); let all = "";
  for await (const chunk of res.body) { const t = dec.decode(chunk, { stream: true }); all += t; process.stdout.write(t.replace(/\n/g, "\n  ")); }
  out(); return all;
}

const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", ".cache", ".voyd"]);
const MAX_READ = 200_000, MAX_WRITE = 600_000;

// keep every path inside the project folder
function inside(p = ".") {
  const f = path.resolve(ROOT, String(p));
  if (f !== ROOT && !f.startsWith(ROOT + path.sep)) throw new Error("That path is outside the project folder.");
  if (f.split(path.sep).includes(".git")) throw new Error(".git is off limits.");
  return f;
}
const rel = (f) => path.relative(ROOT, f) || ".";
const kb = (n) => (n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB");

const tools = {
  async list_files({ path: p }) {
    const start = inside(p), list = [];
    async function walk(d) {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (list.length >= 400) return;
        if (SKIP.has(e.name)) continue;
        const f = path.join(d, e.name);
        if (e.isDirectory()) { list.push(rel(f) + "/"); await walk(f); } else list.push(`${rel(f)} (${kb((await stat(f)).size)})`);
      }
    }
    await walk(start);
    return list.length ? list.join("\n") : "(empty folder)";
  },
  async read_file({ path: p }) {
    const f = inside(p), s = await stat(f);
    if (s.size > MAX_READ) return `File is ${kb(s.size)}; only the first ${kb(MAX_READ)} is shown.\n` + (await readFile(f, "utf8")).slice(0, MAX_READ);
    return await readFile(f, "utf8");
  },
  async write_file({ path: p, content }) {
    const f = inside(p), text = String(content ?? "");
    if (Buffer.byteLength(text) > MAX_WRITE) throw new Error("File is too large to write.");
    let existed = true; try { await stat(f); } catch { existed = false; }
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, text);
    return `${existed ? "Updated" : "Created"} ${rel(f)} (${kb(Buffer.byteLength(text))}).`;
  },
};
const label = { list_files: (i) => `look    ${i.path || "."}`, read_file: (i) => `read    ${i.path}`, write_file: (i) => `write   ${i.path}  ${dim("(" + kb(Buffer.byteLength(String(i.content ?? ""))) + ")")}` };

// a quiet spinner while the voyd works
function spin(text) {
  if (!tty) return () => {};
  const f = ["◐", "◓", "◑", "◒"]; let i = 0; const t0 = Date.now();
  const h = setInterval(() => process.stdout.write(`\r${hi(f[i++ % 4])} ${dim(text + " " + Math.round((Date.now() - t0) / 1000) + "s")}  `), 120);
  return () => { clearInterval(h); process.stdout.write("\r\x1b[2K"); };
}

// one task: the conversation is append-only and sent back exactly as the model produced it
async function task(messages, prompt) {
  messages.push({ role: "user", content: prompt });
  const t0 = Date.now(); let writes = 0;
  for (let step = 0; step < 50; step++) {
    if (JSON.stringify(messages).length > 3_800_000) throw new Error("This session is too long. Type /clear to start a fresh one (your files stay).");
    const stop = spin(step ? "the voyd is working" : "the voyd is listening");
    let r; try { r = await postJson("/api/agent", { messages }); } finally { stop(); }
    messages.push({ role: "assistant", content: r.content });
    for (const b of r.content) if (b.type === "text" && b.text.trim()) out(md(b.text.trim()).split("\n").map((l) => "  " + l).join("\n"));
    const uses = r.content.filter((b) => b.type === "tool_use");
    if (!uses.length || r.stop_reason !== "tool_use") break;
    const results = [];
    for (const u of uses) {
      try {
        const fn = tools[u.name]; if (!fn) throw new Error("Unknown tool.");
        const res = await fn(u.input || {});
        if (u.name === "write_file") writes++;
        out(`  ${hi("◇")} ${(label[u.name] || (() => u.name))(u.input || {})}`);
        results.push({ type: "tool_result", tool_use_id: u.id, content: res });
      } catch (e) {
        out(`  ${red("✕")} ${u.name}: ${e.message}`);
        results.push({ type: "tool_result", tool_use_id: u.id, content: e.message, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }
  out(`  ${hi("✓")} it came back in ${Math.round((Date.now() - t0) / 1000)}s${writes ? ` · ${writes} file${writes > 1 ? "s" : ""} written` : ""}`);
}

function preview(port = 4321) {
  const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json" };
  http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname); if (p.endsWith("/")) p += "index.html";
      const f = inside("." + p), data = await readFile(f);
      res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" }); res.end(data);
    } catch { res.writeHead(404); res.end("Not found"); }
  }).listen(port, "127.0.0.1", () => {
    const u = `http://localhost:${port}`;
    out(`  ${hi("✓")} serving ${bold(path.basename(ROOT))} on ${u}  ${dim("(ctrl+c to stop)")}`);
    exec(`${process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"} ${u}`, () => {});
  }).on("error", (e) => { out(red(`  ✕ ${e.code === "EADDRINUSE" ? `port ${port} is busy; try voyd preview ${port + 1}` : e.message}`)); process.exit(1); });
}

// voyd ship: upload this folder's static files to voydagent.com/s/<name>
const SHIP_EXT = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".txt", ".woff", ".woff2", ".mp4", ".webm", ".xml", ".webmanifest"]);
async function ship(name) {
  name = String(name || path.basename(ROOT)).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  const files = []; let bytes = 0;
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else if (SHIP_EXT.has(path.extname(e.name).toLowerCase())) { const buf = await readFile(f); bytes += buf.length; if (bytes > 8_000_000) throw new Error("This folder is over 8 MB of web files. Ship a smaller site."); files.push({ path: rel(f).split(path.sep).join("/"), data: buf.toString("base64") }); }
    }
  }
  await walk(ROOT);
  if (!files.some((f) => f.path === "index.html")) throw new Error("No index.html here. Build something first: voyd \"…\"");
  const stop = spin(`shipping ${files.length} files`);
  let r; try { r = await postJson("/api/ship", { name, files }, 120_000); } finally { stop(); }
  out(`  ${hi("✓")} it's live: ${bold(r.url)}  ${dim(`(${r.files} files, ${kb(r.bytes)})`)}`);
}

function banner() {
  out();
  out(`  ${hi("▼")} ${bold("VOYD")} ${dim("v" + VERSION + " · speak into the voyd")}`);
  out(dim(`  working in ${ROOT}`));
  out();
}

// sign in with the access code from the website; it is kept in ~/.voyd/config.json (readable by you only)
async function login(code) {
  code = String(code || "").trim().toUpperCase();
  if (!/^VOYD-[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/.test(code)) { out(red("  ✕ That doesn't look like an access code (VOYD-XXXXX-XXXXX-XXXXX-XXXXX).")); out(dim("  " + GET_CODE)); return (process.exitCode = 1); }
  let res, j;
  try { res = await fetch(SERVER + "/api/access/me", { headers: { "x-voyd-code": code, "x-voyd-device": await deviceId() } }); j = await res.json(); } catch { out(red("  ✕ Can't reach the voyd. Check your connection.")); return (process.exitCode = 1); }
  if (!res.ok) { out(red("  ✕ " + (j.error || "That code didn't work."))); return (process.exitCode = 1); }
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  await writeFile(CONF, JSON.stringify({ code }, null, 1), { mode: 0o600 });
  out(`  ${hi("✓")} signed in · ${j.owner ? "team access" : j.wallet.slice(0, 6) + "…" + j.wallet.slice(-4) + " holds $VOYD · locked to this device"}`);
}
async function whoami() {
  const code = await savedCode(); if (!code) return out(dim("  Not signed in. " + GET_CODE));
  try { const res = await fetch(SERVER + "/api/access/me", { headers: { "x-voyd-code": code, "x-voyd-device": await deviceId() } }), j = await res.json(); out(res.ok ? `  ${hi("✓")} ${j.owner ? "team access" : j.wallet}` : red("  ✕ " + j.error)); } catch { out(red("  ✕ Can't reach the voyd.")); }
}

const BRAND = (brief) => `Create a brand kit in the folder ./brand for this project: ${brief || "the project in this folder (read it first to learn its name and vibe)"}.
Write these files:
- brand/logo-1.svg, brand/logo-2.svg, brand/logo-3.svg: three clearly different logo concepts (an abstract mark, a letterform, a pictorial idea). viewBox 0 0 256 256, clean geometric shapes, at most 2 colours, no <text> elements, no gradients, readable at 32px.
- brand/x-profile.txt: display name, 3 bio options under 160 characters, a pinned-post idea.
- brand/dex-info.txt: a one-line tagline, a 2-sentence short description and a 1-paragraph long description.
- brand/palette.txt: the colours with hex codes and where to use them.
- brand/index.html: one page that shows the three logos large and small, on dark and light, with the palette, so it can be previewed.
Then summarise the three concepts in one line each.`;
const XKIT = (brief) => `Create an X (Twitter) content kit in the folder ./x for this project: ${brief || "the project in this folder (read it first to learn its name, vibe and what it does)"}.
Write these files:
- x/profile.txt: display name, 3 bio options under 160 characters, a header-image idea, the pinned post.
- x/launch-thread.txt: a launch thread of 5 to 7 posts. The first line of post 1 is a hook that makes people stop scrolling. Each post under 270 characters.
- x/posts.txt: 10 standalone posts for the first two weeks, numbered, each with a one-line note on when to post it and why it works. Mix: product proof, memes, community questions, behind the scenes. Short lines, one idea per post, a question or a call at the end.
- x/cards.html: one page with 3 post images at exactly 1600x900 each (one per section, stacked), bold type, the project's colours, ready to screenshot and attach to posts. No external images; inline SVG or CSS only.
Rules: no price promises, no "100x", never say a token is live or listed unless the user said so, leave a contract address as <CA>.
Then summarise what is in each file in one line each.`;
const FIX = (roast) => roast
  ? `Improve the website in this folder. A roast of it found these problems:\n\n${roast}\n\nRead the files, then fix the problems that are real for this code (design, copy, mobile, speed, accessibility, trust). Keep what already works. Summarise what you changed.`
  : "Review the website in this folder like a senior designer and developer, then fix the biggest problems (design, copy, mobile layout, speed, accessibility). Keep what already works. Summarise what you changed.";

const HELP = `
  ${bold('voyd "<one sentence>"')}        build it in this folder
  ${bold("voyd")}                        open a session here and keep iterating
  ${bold("voyd preview [port]")}         serve this folder and open it in the browser
  ${bold("voyd ship [name]")}            put this folder live at voydagent.com/s/<name>
  ${bold("voyd audit <contract>")}       score a Robinhood Chain token contract (0-100)
  ${bold("voyd roast <url>")}            a brutally honest review of any website
  ${bold("voyd fix")}                    improve the site in this folder (uses the last roast)
  ${bold('voyd brand ["<project>"]')}    3 logo concepts, X bio and DEX info in ./brand
  ${bold('voyd x ["<project>"]')}        X content: bio, launch thread, 10 posts, post images in ./x
  ${bold("voyd login <code>")}           sign in with the code from your wallet
  ${bold("voyd whoami")} / ${bold("voyd logout")}

  In a session: type what you want, ${dim("/clear")} to start over, ${dim("/exit")} to leave.
  The voyd only reads and writes files inside the folder you start it in.
`;

async function run(fn) { try { await fn(); } catch (e) { out(red("  ✕ " + e.message)); process.exitCode = 1; } }
const args = process.argv.slice(2), cmd = args[0];
if (cmd === "-v" || cmd === "--version") out(VERSION);
else if (cmd === "-h" || cmd === "--help" || cmd === "help") out(HELP);
else if (cmd === "preview") preview(+args[1] || 4321);
else if (cmd === "login") await login(args[1]);
else if (cmd === "logout") { await rm(CONF, { force: true }); out(`  ${hi("✓")} signed out`); }
else if (cmd === "whoami") await whoami();
else if (cmd === "ship") { banner(); await run(() => ship(args[1])); }
else if (cmd === "audit") {
  banner();
  await run(async () => { if (!args[1]) throw new Error("Usage: voyd audit <contract address>"); out(dim(`  reading ${args[1]} from Robinhood Chain…\n`)); process.stdout.write("  "); await postStream("/api/audit", { address: args[1] }); });
}
else if (cmd === "roast") {
  banner();
  await run(async () => {
    if (!args[1]) throw new Error("Usage: voyd roast <url>");
    out(dim(`  roasting ${args[1]}…\n`)); process.stdout.write("  ");
    const t = await postStream("/api/roast", { url: args[1] });
    await mkdir(path.join(ROOT, ".voyd"), { recursive: true }); await writeFile(path.join(ROOT, ".voyd", "roast.txt"), t);
    out(dim("  saved to .voyd/roast.txt · run voyd fix in the site's folder to fix it"));
  });
}
else if (cmd === "fix") { banner(); let roast = ""; try { roast = await readFile(path.join(ROOT, ".voyd", "roast.txt"), "utf8"); } catch {} await run(() => task([], FIX(roast))); }
else if (cmd === "brand") { banner(); await run(() => task([], BRAND(args.slice(1).join(" ")))); }
else if (cmd === "x") { banner(); await run(() => task([], XKIT(args.slice(1).join(" ")))); }
else if (args.length) { banner(); await run(() => task([], args.join(" "))); }
else {
  banner();
  out(dim("  Say what you want to build. /help for commands, /exit to leave.\n"));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let messages = [];
  rl.on("SIGINT", () => { out(); rl.close(); });
  for (;;) {
    let q; try { q = (await rl.question(hi("› "))).trim(); } catch { break; }
    if (!q) continue;
    if (q === "/exit" || q === "/quit") break;
    if (q === "/clear") { messages = []; out(dim("  New conversation.")); continue; }
    if (q === "/help") { out(HELP); continue; }
    const n = messages.length;
    try { await task(messages, q); } catch (e) { out(red("  ✕ " + e.message)); messages.length = n; }
    out();
  }
  rl.close();
}
