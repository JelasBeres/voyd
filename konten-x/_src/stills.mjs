// node stills.mjs scene t1 t2 ... -> .stills/<scene>.jpg contact sheet
import { chromium } from "/Users/sergiodyegogmail.com/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process"; import fs from "node:fs"; import path from "node:path";
const [s, ...ts] = process.argv.slice(2), dir = path.resolve(".stills"); fs.mkdirSync(dir, { recursive: true });
const b = await chromium.launch(), pg = await b.newPage({ viewport: { width: 1600, height: 900 } }), errs = [];
pg.on("pageerror", (e) => errs.push(e.message));
await pg.goto("file://" + path.resolve("video.html") + "?s=" + s); await pg.waitForTimeout(1500);
const files = [];
for (const t of ts) { await pg.evaluate((t) => window.SCENE.seek(t), +t); const f = `${dir}/${s}-${t}.png`; await pg.locator("#st").screenshot({ path: f }); files.push(f); }
const n = files.length, cols = n > 4 ? 3 : 2, rows = Math.ceil(n / cols);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...files.flatMap((f) => ["-i", f]), "-filter_complex", files.map((_, i) => `[${i}]scale=640:360[a${i}]`).join(";") + ";" + files.map((_, i) => `[a${i}]`).join("") + `xstack=inputs=${n}:layout=` + files.map((_, i) => `${(i % cols) * 640}_${Math.floor(i / cols) * 360}`).join("|") + ":fill=black", "-frames:v", "1", `${dir}/${s}.jpg`]);
files.forEach((f) => fs.rmSync(f)); console.log(s, "errors", errs); await b.close();
