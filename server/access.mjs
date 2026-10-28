// Access codes for the voyd CLI. A wallet that holds enough $VOYD signs one message on voydagent.com and gets one code;
// asking again replaces the old code. A code binds to the first device that uses it (1 wallet = 1 code = 1 device).
// Every CLI call re-checks the balance (cached 10 min), so selling closes access.
import { ethers } from "ethers";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";

const ERC20 = ["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)"];
const MSG = /^VOYD access\nWallet: (0x[0-9a-fA-F]{40})\nIssued: (\d{13})$/;
const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1: easy to read and type
const err = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });
const hash = (code) => createHash("sha256").update(String(code).trim().toUpperCase()).digest("hex");

export function createAccess({ dir, token = () => (process.env.VOYD_TOKEN || "").trim() }) {
  const minBps = () => BigInt(process.env.VOYD_MIN_BPS || 10); // 10 bps = 0.1% of supply
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com", undefined, { staticNetwork: true });
  const FILE = path.join(dir, "access.json");
  let db = { codes: {}, wallets: {} }, loaded = false, saving = Promise.resolve();

  async function load() { if (loaded) return; try { db = JSON.parse(await readFile(FILE, "utf8")); } catch {} loaded = true; }
  function save() {
    saving = saving.then(async () => { await mkdir(dir, { recursive: true }); const tmp = FILE + ".tmp"; await writeFile(tmp, JSON.stringify(db, null, 1), { mode: 0o600 }); await rename(tmp, FILE); });
    return saving;
  }
  function newCode() {
    const b = randomBytes(20); let s = "";
    for (const x of b) s += B32[x & 31];
    return "VOYD-" + s.match(/.{5}/g).join("-");
  }

  // holder check, cached per wallet for 10 minutes
  const cache = new Map();
  async function holder(wallet) {
    const t = token(); if (!t) throw err(503, "$VOYD isn't live yet. Access codes open at launch.");
    const hit = cache.get(wallet); if (hit && Date.now() - hit.at < 600_000) return hit;
    const c = new ethers.Contract(t, ERC20, provider);
    let bal, supply, dec;
    try { [bal, supply, dec] = await Promise.all([c.balanceOf(wallet), c.totalSupply(), c.decimals()]); }
    catch { if (hit) return hit; throw err(503, "Couldn't read the chain right now. Try again in a minute."); }
    const need = (supply * minBps()) / 10000n;
    const r = { at: Date.now(), ok: bal >= need && bal > 0n, have: ethers.formatUnits(bal, dec), need: ethers.formatUnits(need, dec) };
    cache.set(wallet, r);
    return r;
  }

  return {
    info: () => ({ live: !!token(), token: token() || null, minPct: Number(minBps()) / 100, symbol: "VOYD" }),

    async claim({ message, signature }) {
      await load();
      const m = String(message || "").match(MSG);
      if (!m) throw err(400, "Bad message.");
      const issued = +m[2];
      if (Math.abs(Date.now() - issued) > 600_000) throw err(400, "That signature is too old. Sign again.");
      let signer; try { signer = ethers.verifyMessage(message, String(signature || "")); } catch { signer = ""; }
      const wallet = m[1].toLowerCase();
      if (signer.toLowerCase() !== wallet) throw err(401, "The signature doesn't match the wallet.");
      const h = await holder(wallet);
      if (!h.ok) throw err(403, `This wallet holds ${Number(h.have).toLocaleString("en-US")} $VOYD. You need at least ${Number(h.need).toLocaleString("en-US")} (${Number(minBps()) / 100}% of supply).`);
      const old = db.wallets[wallet];
      if (old) delete db.codes[old];
      const code = newCode();
      db.codes[hash(code)] = { wallet, at: Date.now() };
      db.wallets[wallet] = hash(code);
      await save();
      return { code, wallet, replaced: !!old };
    },

    /** Who a code belongs to; throws if it is unknown, used on another device, or its wallet no longer holds enough.
     *  The first device that presents a code claims it; owner (team) codes are not device-bound. */
    async check(code, device) {
      await load();
      const e = code && db.codes[hash(code)];
      if (!e) throw err(401, "Unknown access code. Get one with your wallet at voydagent.com/#access, then run: voyd login <code>");
      if (e.owner) return { wallet: e.wallet, owner: true };
      if (!/^[0-9a-f]{32,64}$/.test(String(device || ""))) throw err(400, "Please update the CLI: npm i -g https://voydagent.com/voyd-agent.tgz");
      const d = hash(device);
      if (e.device && e.device !== d) throw err(403, "This code is already used on another device. To move to this device, get a new code with your wallet (the old one stops working).");
      const h = await holder(e.wallet);
      if (!h.ok) throw err(403, `The wallet behind this code (${e.wallet.slice(0, 6)}…${e.wallet.slice(-4)}) no longer holds enough $VOYD.`);
      if (!e.device) { e.device = d; e.boundAt = Date.now(); await save(); }
      return { wallet: e.wallet };
    },

    /** Owner codes (for the team, and for testing before launch). Needs VOYD_ADMIN_KEY. */
    async ownerCode(key, label) {
      const want = process.env.VOYD_ADMIN_KEY || "";
      const a = Buffer.from(String(key || "")), b = Buffer.from(want);
      if (want.length < 16 || a.length !== b.length || !timingSafeEqual(a, b)) throw err(401, "Wrong admin key.");
      await load();
      const name = "owner:" + String(label || "team").replace(/[^\w.-]/g, "").slice(0, 32);
      const old = db.wallets[name]; if (old) delete db.codes[old];
      const code = newCode();
      db.codes[hash(code)] = { wallet: name, owner: true, at: Date.now() };
      db.wallets[name] = hash(code);
      await save();
      return { code, wallet: name };
    },
  };
}
