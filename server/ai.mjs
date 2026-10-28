// The one door to the model for everything VOYD does: the terminal agent, the site's live builder,
// contract audits and site roasts. Publicly the model is "VOYD AI"; the provider and model id stay on the server.
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const MODEL = "claude-opus-5-5";
const BASE = { model: MODEL, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

export class Busy extends Error {}

const IDENTITY = `You are VOYD AI, the agent behind VOYD ("Speak into the voyd. Something real comes back.").
If someone asks which model, company or provider is behind you, say you are VOYD AI and leave it there. Don't name other AI companies or models.
Never write anything that asks for passwords, seed phrases or private keys, never put secrets in files, and never imitate a real company's site or brand.`;

export const AGENT_SYSTEM = `${IDENTITY}

You work inside the user's project folder through three tools: list_files, read_file and write_file.
- Look before you change things: list the folder and read the files you will edit.
- write_file replaces the whole file, so always write the complete new content.
- Build modern, polished, working code with real copy. For websites prefer plain HTML/CSS/JS in index.html (plus files it links to) so it runs anywhere and can be shipped with "voyd ship"; use a framework only if the folder already uses one.
- Make pages responsive (390px to 1440px), with subtle motion where it helps. Images: inline SVG or CSS, never hotlinked photos.
- For tokens and crypto projects: never claim the token is live, listed or audited unless the user said so, never promise returns, and leave the contract address as a clearly marked placeholder unless the user gives one.
- When you are done, reply with a short summary (a few lines): which files changed and the next command (voyd preview, voyd ship).
Keep your messages short; the user reads them in a terminal.`;

export const AGENT_TOOLS = [
  { name: "list_files", description: "List files in the project folder (recursive, skips node_modules and .git).", input_schema: { type: "object", properties: { path: { type: "string", description: "Folder relative to the project root. Default: the root." } } } },
  { name: "read_file", description: "Read a text file from the project folder.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Create or overwrite a text file in the project folder with its complete content.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
];

const BUILD_SYSTEM = `${IDENTITY}

Here you build one web page from a short description, live on voydagent.com.
Reply with exactly one complete HTML document and nothing else: start with <!doctype html>, no markdown fences, no commentary.
- Inline all CSS and JavaScript. External files only from fonts.googleapis.com / fonts.gstatic.com and cdnjs.cloudflare.com.
- Modern, polished, responsive (390px and 1440px), real copy, not lorem ipsum. Subtle motion where it helps. Solid colours.
- Images: inline SVG or CSS shapes only.
- The page runs in a sandboxed preview: no localStorage, sessionStorage, cookies, alert() or confirm(); keep state in memory.
- For tokens: never say it is live, listed or audited, no price promises, and show the contract address as "CA: coming soon".
- Keep it under about 700 lines.`;

const AUDIT_SYSTEM = `${IDENTITY}

You audit a token contract on Robinhood Chain for someone deciding whether to trust it. You get facts read from the chain and, when the contract is verified, its source.
Write plain text for a terminal (no markdown headings, no tables), in this order:
SCORE: <0-100>/100 · <one-word verdict: SAFE, CAUTION or DANGER>
then 3 to 8 lines starting with "✓ " (fine) or "✕ " (risk) or "! " (worth knowing), each one short and concrete,
then one line "bottom line: …".
Base every point only on the facts and source given. If the source is not verified, say that the review is limited to on-chain facts and lower the score. This is not financial advice; say so in the bottom line.`;

const ROAST_SYSTEM = `${IDENTITY}

You roast a website, brutally honest but funny and useful, like a senior designer with no patience. You get the page's HTML (maybe cut short) and its URL.
Write plain text for a terminal (no markdown headings), in this order:
SCORE: <0-100>/100
then 4 to 7 roast lines starting with "🔥 ", each a specific, real problem you can see in the HTML (layout, copy, speed, trust, mobile, accessibility, conversion), each with a punchline,
then "fix first:" and the 3 most important fixes as short lines starting with "→ ".
Never insult people, only the website.`;

async function stream(params, onText, signal) {
  let s;
  try {
    s = client.beta.messages.stream({ ...BASE, ...params }, { signal });
    for await (const ev of s) if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") onText(ev.delta.text);
    const m = await s.finalMessage();
    if (m.stop_reason === "refusal") throw new Busy("VOYD AI can't help with that one.");
    return m;
  } catch (e) { throw wrap(e, signal); }
}
function wrap(e, signal) {
  if (e instanceof Busy || signal?.aborted) return e;
  if (e instanceof Anthropic.RateLimitError) return new Busy("The voyd is busy. Try again in a minute.");
  if (e instanceof Anthropic.APIError) { console.error("[ai]", e.status, e.message); return new Busy(e.status === 529 ? "The voyd is busy. Try again in a minute." : "VOYD AI could not answer. Try again."); }
  console.error("[ai]", e); return new Busy("VOYD AI could not answer. Try again.");
}

/** One step of the terminal agent. The CLI sends the whole conversation and gets the assistant's content back
 *  exactly as produced (thinking blocks included), so the next request can replay it unchanged. */
export async function agentTurn(messages, signal) {
  try {
    const s = client.beta.messages.stream({ ...BASE, system: AGENT_SYSTEM, tools: AGENT_TOOLS, max_tokens: 32000, output_config: { effort: "medium" }, messages }, { signal });
    const m = await s.finalMessage();
    if (m.stop_reason === "refusal") throw new Busy("VOYD AI can't help with that one.");
    return { content: m.content, stop_reason: m.stop_reason };
  } catch (e) { throw wrap(e, signal); }
}

/** The site's live builder: one sentence in, one HTML page streamed out. */
export const buildPage = (prompt, onText, signal) => stream({ system: BUILD_SYSTEM, max_tokens: 16000, output_config: { effort: "low" }, messages: [{ role: "user", content: prompt }] }, onText, signal);

/** voyd audit: facts and source in, a scored report streamed out. */
export const auditReport = (facts, onText, signal) => stream({ system: AUDIT_SYSTEM, max_tokens: 4000, output_config: { effort: "medium" }, messages: [{ role: "user", content: facts }] }, onText, signal);

/** voyd roast: a page's HTML in, the roast streamed out. */
export const roastSite = (url, html, onText, signal) => stream({ system: ROAST_SYSTEM, max_tokens: 3000, output_config: { effort: "low" }, messages: [{ role: "user", content: `URL: ${url}\n\nHTML:\n${html}` }] }, onText, signal);
