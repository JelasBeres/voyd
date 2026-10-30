// node peek.mjs scene t1 t2 ... -> stills to check a scene quickly
import { chromium } from "/Users/sergiodyegogmail.com/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import path from "node:path";
const [s, ...ts] = process.argv.slice(2), QS = process.env.Q ? "&" + process.env.Q : "", b = await chromium.launch(), p = await b.newPage({ viewport: { width: 1600, height: 900 } }), errs = [];
p.on("pageerror", (e) => errs.push(e.message));
await p.goto("file://" + path.resolve("video.html") + "?s=" + s + QS); await p.waitForTimeout(1200);
for (const t of ts) { await p.evaluate((t) => window.SCENE.seek(t), +t); await p.locator("#st").screenshot({ path: `${process.env.PEEK_DIR || "/tmp"}/peek-${s}-${t}.png` }); }
console.log(s, errs); await b.close();
