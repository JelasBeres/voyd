// node video.mjs [scene...]  -> ../video/<nn>-<scene>.mp4 (1920x1080, 30 fps) and a poster ../video/<nn>-<scene>.jpg
import { chromium } from "/Users/sergiodyegogmail.com/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs"; import path from "node:path";
const ALL = ["speak", "live", "vs", "said", "roast", "sleep", "tiers", "real", "open", "speedrun", "dev", "burn", "vending", "delete", "crt", "captcha", "receipt", "translate"];
const list = process.argv.slice(2).length ? process.argv.slice(2) : ALL, out = path.resolve("../video"); fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch(), fps = 30;
for (const s of list) {
  const num = "v" + (ALL.indexOf(s) + 1), p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2 }), errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("file://" + path.resolve("video.html") + "?s=" + s + (process.env.Q ? "&" + process.env.Q : "")); await p.waitForTimeout(1500);
  const dur = await p.evaluate(() => window.SCENE.dur), dir = path.resolve(`.frames-${s}`); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
  const el = p.locator("#st"), total = Math.round(dur * fps);
  for (let i = 0; i < total; i++) { await p.evaluate((t) => window.SCENE.seek(t), i / fps); await el.screenshot({ path: `${dir}/${String(i).padStart(4, "0")}.jpg`, type: "jpeg", quality: 90 }); }
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", `${dir}/%04d.jpg`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", "-movflags", "+faststart", `${out}/${num}-${s}.mp4`]);
  fs.copyFileSync(`${dir}/${String(Math.round(total * 0.45)).padStart(4, "0")}.jpg`, `${out}/${num}-${s}.jpg`);
  fs.rmSync(dir, { recursive: true, force: true }); console.log("mp4", s, dur + "s", errs); await p.close();
}
await b.close();
