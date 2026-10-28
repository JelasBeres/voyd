// What the CLI's server-side commands read and keep: contract facts for voyd audit, a safely fetched page for
// voyd roast, and shipped sites for voyd ship (served at /s/<name>/ in a sandbox).
import { ethers } from "ethers";
import dns from "node:dns/promises";
import net from "node:net";
import { readFile, writeFile, rename, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const err = (code, message) => Object.assign(new Error(message), { code });
const EXPLORER = "https://explorer.mainnet.chain.robinhood.com";
const PONS = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const DEAD = "0x000000000000000000000000000000000000dEaD";

/* ---------- voyd audit ---------- */

const RISKY = {
  "mint(address,uint256)": "can mint new tokens", "setFee(uint256)": "owner can change fees", "setFees(uint256,uint256)": "owner can change fees",
  "setTaxFee(uint256)": "owner can change tax", "setBuyFee(uint256)": "owner can change buy fee", "setSellFee(uint256)": "owner can change sell fee",
  "blacklist(address)": "owner can blacklist wallets", "addToBlacklist(address)": "owner can blacklist wallets", "setBlacklist(address,bool)": "owner can blacklist wallets",
  "setBot(address,bool)": "owner can flag wallets as bots", "pause()": "owner can pause transfers", "setMaxTxAmount(uint256)": "owner can limit transaction size",
  "setMaxWallet(uint256)": "owner can limit wallet size", "enableTrading()": "trading can be switched on by the owner", "setTradingEnabled(bool)": "owner can switch trading on or off",
  "excludeFromFee(address)": "owner can exempt wallets from fees", "upgradeTo(address)": "contract is upgradeable", "upgradeToAndCall(address,bytes)": "contract is upgradeable",
};
const SEL = Object.entries(RISKY).map(([sig, why]) => ({ sig, why, hex: "63" + ethers.id(sig).slice(2, 10) }));

// verified source: the Blockscout explorer first, then Sourcify (which also indexes chain 4663)
async function verifiedSource(a) {
  try {
    const j = await (await fetch(`${EXPLORER}/api/v2/smart-contracts/${a}`, { signal: AbortSignal.timeout(6_000) })).json();
    if (j.is_verified && j.source_code) {
      const extra = (j.additional_sources || []).map((s) => `// ${s.file_path}\n${s.source_code}`).join("\n\n");
      return `Verified source (explorer, ${j.name || "contract"}, compiler ${j.compiler_version || "?"}):\n${(j.source_code + "\n\n" + extra).slice(0, 60_000)}`;
    }
  } catch {}
  try {
    const r = await fetch(`https://sourcify.dev/server/v2/contract/4663/${a}?fields=sources`, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) {
      const j = await r.json(), src = Object.entries(j.sources || {}).map(([p, v]) => `// ${p}\n${v.content}`).join("\n\n");
      if (src) return `Verified source (Sourcify, ${j.match || "match"}):\n${src.slice(0, 60_000)}`;
    }
  } catch {}
  return "Source code: NOT verified (not found on the explorer or Sourcify), so only on-chain facts and a bytecode scan are available.";
}

export async function auditFacts(provider, raw) {
  if (!ethers.isAddress(String(raw || "").trim())) throw err(400, "That is not a contract address.");
  const a = ethers.getAddress(String(raw).trim()), code = await provider.getCode(a);
  if (code === "0x") throw err(400, "No contract at that address on Robinhood Chain.");
  const f = [`Contract: ${a} on Robinhood Chain (chain id 4663)`, `Bytecode size: ${(code.length - 2) / 2} bytes`];
  const c = new ethers.Contract(a, ["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function owner() view returns (address)"], provider);
  const get = (p) => p.then((v) => v, () => null);
  const [name, symbol, dec, supply, owner, dead] = await Promise.all([get(c.name()), get(c.symbol()), get(c.decimals()), get(c.totalSupply()), get(c.owner()), get(c.balanceOf(DEAD))]);
  const pct = (v) => supply && v != null ? (Number((v * 1_000_000n) / (supply || 1n)) / 10_000).toFixed(2) + "%" : "?";
  if (name != null) f.push(`Token: ${name} (${symbol}), ${dec} decimals, total supply ${supply != null ? ethers.formatUnits(supply, dec ?? 18) : "?"}`);
  else f.push("Not a standard ERC-20 (name() failed).");
  f.push(owner == null ? "owner(): not present" : BigInt(owner) === 0n ? "owner(): renounced (zero address)" : `owner(): ${owner}`);
  if (dead != null) f.push(`Held by the dead address (burned): ${pct(dead)}`);
  const impl = await get(provider.getStorage(a, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"));
  if (impl && BigInt(impl) !== 0n) f.push(`EIP-1967 proxy: implementation ${ethers.getAddress("0x" + impl.slice(26))} (the logic can be swapped)`);
  const hits = SEL.filter((s) => code.includes(s.hex));
  f.push(hits.length ? "Functions found in the bytecode: " + hits.map((h) => `${h.sig} (${h.why})`).join("; ") : "No common owner-control functions (mint, fees, blacklist, pause, max tx, upgrade) found in the bytecode.");
  try {
    const rec = await new ethers.Contract(PONS, ["function getLaunchedToken(address) view returns (tuple(address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint256 initialLiquidity, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, bool exists))"], provider).getLaunchedToken(a);
    if (rec.exists) {
      const grad = await get(new ethers.Contract(rec.curve, ["function graduated() view returns (bool)"], provider).graduated());
      const devBal = await get(c.balanceOf(rec.deployer));
      f.push(`Launched on Pons (standard launchpad contract). Deployer ${rec.deployer} holds ${pct(devBal)}. Creator tax ${Number(rec.creatorTaxBps) / 100}%. ${grad ? "Graduated to a Uniswap pool." : "Still on its bonding curve."}`);
    } else f.push("Not a Pons launchpad token.");
  } catch { f.push("Pons check failed (could not read the launchpad)."); }
  f.push(await verifiedSource(a));
  try {
    const j = await (await fetch(`${EXPLORER}/api/v2/tokens/${a}/holders`, { signal: AbortSignal.timeout(10_000) })).json();
    const items = (j.items || []).slice(0, 10);
    if (items.length && supply) f.push("Top holders: " + items.map((h) => `${h.address?.hash?.slice(0, 8)}… ${pct(BigInt(h.value))}${h.address?.is_contract ? " (contract)" : ""}`).join(", "));
  } catch {}
  return f.join("\n");
}

/* ---------- voyd roast: fetch a public page, never the server's own network ---------- */

function privateIp(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split(".").map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  const v = ip.toLowerCase(); return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:") && privateIp(v.slice(7));
}
export async function fetchPage(raw) {
  let url; try { url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); } catch { throw err(400, "That is not a URL."); }
  for (let hop = 0; hop < 4; hop++) {
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw err(400, "Only public http(s) pages can be roasted.");
    const addrs = await dns.lookup(url.hostname, { all: true }).catch(() => []);
    if (!addrs.length) throw err(400, "That site does not resolve.");
    if (addrs.some((x) => privateIp(x.address))) throw err(400, "Only public sites can be roasted.");
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(12_000), headers: { "user-agent": "VOYD-roast/1.0 (+https://voydagent.com)", accept: "text/html" } }).catch(() => null);
    if (!r) throw err(400, "Could not reach that site.");
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { url = new URL(r.headers.get("location"), url); continue; }
    if (!r.ok) throw err(400, `That site answered ${r.status}.`);
    if (!/html/i.test(r.headers.get("content-type") || "")) throw err(400, "That URL is not a web page.");
    const reader = r.body.getReader(), parts = []; let n = 0;
    while (n < 300_000) { const { value, done } = await reader.read(); if (done) break; parts.push(value); n += value.length; }
    reader.cancel().catch(() => {});
    const html = Buffer.concat(parts).toString("utf8").replace(/<script\b[^>]*>[\s\S]{2000,}?<\/script>/gi, "<script>/* long script cut */</script>").replace(/<svg\b[\s\S]*?<\/svg>/gi, "<svg/>");
    return { url: url.href, html: html.slice(0, 60_000) };
  }
  throw err(400, "Too many redirects.");
}

/* ---------- voyd ship: static sites at /s/<name>/ ---------- */

const EXT = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".txt", ".woff", ".woff2", ".mp4", ".webm", ".xml", ".webmanifest"]);
export const SITE_MIME = { ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".woff": "font/woff", ".woff2": "font/woff2", ".mp4": "video/mp4", ".webm": "video/webm", ".xml": "application/xml", ".webmanifest": "application/manifest+json" };
const BAD = /seed phrase|secret recovery phrase|mnemonic phrase|enter your private key|wallet recovery|eth_sign\b|setApprovalForAll|permit2/i;

export function createSites(dir) {
  const ROOT = path.join(dir, "sites"), META = path.join(dir, "sites.json");
  let meta = null;
  async function load() { if (!meta) { try { meta = JSON.parse(await readFile(META, "utf8")); } catch { meta = {}; } } return meta; }
  async function saveMeta() { await mkdir(dir, { recursive: true }); await writeFile(META + ".tmp", JSON.stringify(meta, null, 1), { mode: 0o600 }); await rename(META + ".tmp", META); }
  return {
    root: ROOT,
    async ship(who, rawName, files) {
      await load();
      const name = String(rawName || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
      if (name.length < 3) throw err(400, "Pick a name of at least 3 letters: voyd ship <name>");
      if (["admin", "api", "assets", "voyd", "www", "app"].includes(name)) throw err(400, "That name is reserved.");
      const own = meta[name];
      if (own && own.wallet !== who.wallet && !who.owner) throw err(403, `voydagent.com/s/${name} belongs to another wallet. Pick another name.`);
      if (!Array.isArray(files) || !files.length) throw err(400, "Nothing to ship.");
      if (files.length > 300) throw err(400, "Too many files (max 300).");
      let total = 0; const clean = [];
      for (const f of files) {
        const p = String(f.path || "").replace(/\\/g, "/").replace(/^\.?\//, "");
        if (!p || p.split("/").some((s) => !s || s === "." || s === ".." || s.startsWith(".")) || !/^[\w./-]+$/.test(p)) throw err(400, `Bad file path: ${p}`);
        if (!EXT.has(path.extname(p).toLowerCase())) continue;
        const buf = Buffer.from(String(f.data || ""), "base64"); total += buf.length;
        if (total > 8_000_000) throw err(400, "Site is too large (max 8 MB).");
        if (/\.(html?|js|mjs)$/i.test(p) && BAD.test(buf.toString("utf8"))) throw err(400, `${p} looks like it asks for wallet secrets or approvals. voyd ship refuses to host that.`);
        clean.push({ p, buf });
      }
      if (!clean.some((f) => f.p === "index.html")) throw err(400, "There is no index.html in this folder.");
      const tmp = path.join(ROOT, `.${name}-${Date.now()}`), dest = path.join(ROOT, name);
      for (const f of clean) { const out = path.join(tmp, f.p); await mkdir(path.dirname(out), { recursive: true }); await writeFile(out, f.buf); }
      await rm(dest, { recursive: true, force: true }); await rename(tmp, dest);
      meta[name] = { wallet: own?.wallet || who.wallet, at: Date.now(), files: clean.length, bytes: total }; await saveMeta();
      return { name, path: `/s/${name}/`, files: clean.length, bytes: total };
    },
    async list() { await load(); return Object.entries(meta).map(([name, m]) => ({ name, ...m })).sort((a, b) => b.at - a.at); },
    async remove(name) { await load(); if (!meta[name]) throw err(404, "No such site."); await rm(path.join(ROOT, name), { recursive: true, force: true }); delete meta[name]; await saveMeta(); },
  };
}
