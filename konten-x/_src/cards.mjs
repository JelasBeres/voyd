// node cards.mjs -> ../img/<card>.png
import { chromium } from "/Users/sergiodyegogmail.com/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import fs from "node:fs"; import path from "node:path";
const out = path.resolve("../img"); fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch(), pg = await b.newPage({ viewport: { width: 1700, height: 1000 } });
await pg.goto("file://" + path.resolve("cards.html")); const all = await pg.evaluate(() => window.CARDS);
for (const c of all) { await pg.goto("file://" + path.resolve("cards.html") + "?c=" + c); await pg.waitForTimeout(900); await pg.locator("#c").screenshot({ path: `${out}/${c}.png` }); console.log(c); }
await b.close();
