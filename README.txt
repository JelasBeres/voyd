VOYD · speak into the voyd. something real comes back.
=======================================================

An AI agent that lives in your terminal. Say one sentence; it writes the project into your folder,
then ships it to a live link. $VOYD on Robinhood Chain via Pons. Not affiliated with Robinhood.

Website   https://voydagent.com
Docs      https://voydagent.com/docs
X         https://x.com/voydagent

WHAT'S IN HERE
  site/        the website (index.html), docs.html, the owner panel (admin.html), voyd-agent.tgz
  server/      Node server: serves the site, the Ask the voyd chat, the CLI's backend
               (holder access, agent, audit, roast, ship → /s/<name>/), the live builder,
               and buyback & burn (burn.mjs)
  cli/         the voyd CLI (bin/voyd.mjs). Packed with: cd cli && npm pack
  deploy/      nginx config and deploy.sh
  brand/       logo files (Echo V), the echo-X icon, logo concepts
  konten-x/    X content: README.txt playbook, videos, images, and their sources (_src)

INSTALL THE CLI
  npm i -g https://voydagent.com/voyd-agent.tgz
  voyd login <code from voydagent.com/#access>
  voyd help

RUN THE SERVER LOCALLY
  cd server
  npm install
  create server/.env with:
    ANTHROPIC_API_KEY=...
    PORT=4200
    VOYD_ADMIN_KEY=<random, 32+ chars>
    BURN_SECRET=<random, 64 hex chars>
    BURN_MAX_USD=100
    BURN_DAY_USD=300
  npm start  →  http://localhost:4200

Secrets (.env) and runtime data (data/: access codes, burn wallet, shipped sites) are never committed.
