// Buyback & burn, run by hand from the owner panel (/admin).
// The owner saves a SEPARATE burn wallet's key once. It is encrypted at rest with BURN_SECRET from .env and never leaves
// the server. The only things this code does with it: buy $VOYD with the dead address as the receiver (so everything
// bought is burned in the same transaction), or send $VOYD the wallet already holds to the dead address.
// Before graduation it buys on the token's Pons curve; after graduation on its Uniswap v3 pool. Capped per run and per day.
import { ethers } from "ethers";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";

export const DEAD = "0x000000000000000000000000000000000000dEaD";
const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"; // Pons launchpad
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2"; // Uniswap SwapRouter02 on Robinhood Chain
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function transfer(address,uint256) returns (bool)"];
const PONS = ["function getLaunchedToken(address token) view returns (tuple(address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint256 initialLiquidity, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, bool exists))"];
const CURVE = ["function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)", "function graduated() view returns (bool)", "function currentSnipeTaxBps(address recipient) view returns (uint256)"];
const ROUTER_ABI = ["function factory() view returns (address)", "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"];
const POOL = ["function token0() view returns (address)", "function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)"];
const err = (code, message) => Object.assign(new Error(message), { code });

export function createBurn({ dir, provider, token }) {
  const KEY_FILE = path.join(dir, "burn-wallet.json"), LOG_FILE = path.join(dir, "burn-log.json");
  const maxUsd = () => Number(process.env.BURN_MAX_USD || 100), dayUsd = () => Number(process.env.BURN_DAY_USD || 300);
  const secret = () => { const k = process.env.BURN_SECRET || ""; if (k.length < 32) throw err(500, "BURN_SECRET is missing in .env on the server."); return createHash("sha256").update(k).digest(); };
  const seal = (txt) => { const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", secret(), iv), d = Buffer.concat([c.update(txt, "utf8"), c.final()]); return [iv, c.getAuthTag(), d].map((b) => b.toString("base64")).join("."); };
  const unseal = (s) => { const [iv, tag, d] = s.split(".").map((x) => Buffer.from(x, "base64")), c = createDecipheriv("aes-256-gcm", secret(), iv); c.setAuthTag(tag); return Buffer.concat([c.update(d), c.final()]).toString("utf8"); };
  async function save(file, v) { await mkdir(dir, { recursive: true }); await writeFile(file + ".tmp", JSON.stringify(v, null, 1), { mode: 0o600 }); await rename(file + ".tmp", file); }

  let saved = null, log = [], loaded = false, busy = false;
  async function load() {
    if (loaded) return;
    try { saved = JSON.parse(await readFile(KEY_FILE, "utf8")); } catch {}
    try { log = JSON.parse(await readFile(LOG_FILE, "utf8")) || []; } catch {}
    loaded = true;
  }
  async function ethUsd() {
    try { const j = await (await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { signal: AbortSignal.timeout(8000) })).json(); const v = Number(j.data.amount); if (v > 0) return v; } catch {}
    const j = await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", { signal: AbortSignal.timeout(8000) })).json(); return Number(j.ethereum.usd);
  }
  async function burned() {
    const t = token(); if (!t) return null;
    try { const c = new ethers.Contract(t, ERC20, provider); return ethers.formatUnits(await c.balanceOf(DEAD), await c.decimals()); } catch { return null; }
  }
  const today = () => log.filter((x) => Date.now() - x.at < 86_400_000).reduce((a, x) => a + (x.usd || 0), 0);
  function locked() { if (busy) throw err(409, "A burn is already running."); busy = true; return () => { busy = false; }; }
  function signer() { if (!saved) throw err(400, "Save the burn wallet key first."); return new ethers.Wallet(unseal(saved.key), provider); }

  // buys with ETH on the Uniswap v3 pool Pons graduated into, receiver = dead address
  async function buyOnPool(wallet, t, fee, wei) {
    const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
    const fac = new ethers.Contract(await router.factory(), ["function getPool(address,address,uint24) view returns (address)"], provider);
    const pool = await fac.getPool(WETH, t, fee);
    if (BigInt(pool) === 0n) throw err(400, "No Uniswap pool found for the token yet.");
    const p = new ethers.Contract(pool, POOL, provider), [t0, slot] = await Promise.all([p.token0(), p.slot0()]);
    const Q = 2n ** 96n, sp = BigInt(slot.sqrtPriceX96 ?? slot[0]);
    const out = ethers.getAddress(t0) === ethers.getAddress(WETH) ? (wei * sp * sp) / (Q * Q) : (wei * Q * Q) / (sp * sp);
    const params = { tokenIn: WETH, tokenOut: t, fee, recipient: DEAD, amountIn: wei, amountOutMinimum: (out * 95n) / 100n, sqrtPriceLimitX96: 0 };
    await router.exactInputSingle.staticCall(params, { value: wei });
    return { tx: await router.exactInputSingle(params, { value: wei }), quote: out, where: "Uniswap" };
  }

  return {
    /** what anyone may see: totals and the recent burns with their transactions */
    async publicView() {
      await load();
      return { token: token() || null, burned: await burned(), count: log.length, usd: +log.reduce((a, x) => a + (x.usd || 0), 0).toFixed(2), recent: log.slice(-5).reverse().map(({ at, usd, tokens, tx }) => ({ at, usd, tokens, tx })) };
    },

    /** what the owner sees in the panel */
    async view() {
      await load();
      const v = { address: saved?.address || null, maxUsd: maxUsd(), dayUsd: dayUsd(), token: token() || null, today: +today().toFixed(2), log: log.slice(-15).reverse() };
      if (v.address) {
        try { v.eth = ethers.formatEther(await provider.getBalance(v.address)); } catch {}
        if (v.token) try { const c = new ethers.Contract(v.token, ERC20, provider); v.held = ethers.formatUnits(await c.balanceOf(v.address), await c.decimals()); } catch {}
      }
      try { v.ethUsd = await ethUsd(); } catch {}
      if (v.token) try { const rec = await new ethers.Contract(FACTORY, PONS, provider).getLaunchedToken(v.token); v.pons = rec.exists; if (rec.exists) v.graduated = await new ethers.Contract(rec.curve, CURVE, provider).graduated(); } catch {}
      v.burned = await burned();
      return v;
    },

    async setKey(raw) {
      await load();
      const k = String(raw || "").trim();
      if (!k) { saved = null; await save(KEY_FILE, null); return; }
      let w; try { w = new ethers.Wallet(k.startsWith("0x") ? k : "0x" + k); } catch { throw err(400, "That is not a valid private key."); }
      saved = { address: w.address, key: seal(w.privateKey), at: Date.now() }; await save(KEY_FILE, saved);
    },

    /** spend about `usdIn` dollars of ETH buying $VOYD straight into the dead address */
    async run(usdIn) {
      await load();
      const usd = Number(usdIn);
      if (!(usd > 0)) throw err(400, "Enter an amount in dollars.");
      if (usd > maxUsd()) throw err(400, `One burn is capped at $${maxUsd()} (BURN_MAX_USD).`);
      if (today() + usd > dayUsd()) throw err(400, `Daily cap is $${dayUsd()}; $${today().toFixed(2)} already spent in the last 24 h.`);
      const t = token(); if (!t) throw err(400, "Set the $VOYD contract address first.");
      const wallet = signer(), unlock = locked();
      try {
        const rec = await new ethers.Contract(FACTORY, PONS, provider).getLaunchedToken(t);
        if (!rec.exists) throw err(400, "That address is not a Pons token.");
        if (BigInt(rec.pairToken) !== 0n) throw err(400, "The token does not trade against ETH.");
        const price = await ethUsd(), wei = ethers.parseEther((usd / price).toFixed(18));
        const bal = await provider.getBalance(wallet.address);
        if (bal < wei + ethers.parseEther("0.0003")) throw err(400, `The burn wallet has ${ethers.formatEther(bal)} ETH; it needs ${ethers.formatEther(wei)} ETH plus gas.`);
        const erc = new ethers.Contract(t, ERC20, provider), before = await erc.balanceOf(DEAD);
        const curve = new ethers.Contract(rec.curve, CURVE, wallet);
        let sent;
        if (await curve.graduated()) sent = await buyOnPool(wallet, t, rec.poolFee, wei);
        else {
          if ((await curve.currentSnipeTaxBps(DEAD)) > 0n) throw err(400, "Snipe tax is still on. Try again in a few minutes.");
          const quote = await curve.buy.staticCall(wei, 0n, DEAD, { value: wei });
          sent = { tx: await curve.buy(wei, (quote * 97n) / 100n, DEAD, { value: wei }), quote, where: "Pons curve" };
        }
        const rc = await sent.tx.wait();
        if (rc.status !== 1) throw err(502, "The buy reverted.");
        const got = (await erc.balanceOf(DEAD)) - before;
        const entry = { at: Date.now(), kind: "buyback", where: sent.where, usd, eth: ethers.formatEther(wei), ethUsd: price, tokens: ethers.formatUnits(got > 0n ? got : sent.quote, await erc.decimals()), tx: sent.tx.hash };
        log.push(entry); await save(LOG_FILE, log);
        return entry;
      } finally { unlock(); }
    },

    /** send $VOYD the burn wallet already holds (e.g. bought by hand) to the dead address */
    async burnHeld() {
      await load();
      const t = token(); if (!t) throw err(400, "Set the $VOYD contract address first.");
      const wallet = signer(), unlock = locked();
      try {
        const erc = new ethers.Contract(t, ERC20, wallet), bal = await erc.balanceOf(wallet.address);
        if (bal <= 0n) throw err(400, "The burn wallet holds no $VOYD.");
        const tx = await erc.transfer(DEAD, bal), rc = await tx.wait();
        if (rc.status !== 1) throw err(502, "The transfer reverted.");
        const entry = { at: Date.now(), kind: "burn", where: "wallet", usd: 0, eth: "0", tokens: ethers.formatUnits(bal, await erc.decimals()), tx: tx.hash };
        log.push(entry); await save(LOG_FILE, log);
        return entry;
      } finally { unlock(); }
    },
  };
}
