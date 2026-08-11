# fantasy

Personal Sleeper-only fantasy football terminal. Re-scores stat-level projections
through each league's exact scoring settings to find league-conditional value vs.
market, and archives daily snapshots of every source (projections, KTC,
FantasyCalc, FantasyPros, trending, ADP) — history that cannot be backfilled.

Full design + plan: `~/.claude/plans/custom-projections-for-mellow-cloud.md`

## Setup

```bash
# Node 22 (installed via Homebrew at /usr/local/opt/node@22/bin — add to PATH)
corepack enable pnpm
pnpm install
cp .env.example .env   # then fill in secrets (see below)
pnpm db:migrate
npx tsx scripts/seed-crosswalk.ts   # one-time player ID crosswalk seed
```

## Running

```bash
pnpm worker        # cron scheduler + catch-up sweep (the only DB writer)
pnpm job           # list all jobs
pnpm job <name>    # run one job once (e.g. pnpm job ktc.values)
pnpm job --all     # run everything serially
pnpm dev           # web UI (Next.js) — read-only against the DB
pnpm mcp           # MCP stdio server — read-only tools
```

The worker owns all ingestion writes and is the only process that runs
migrations. Raw API payloads are archived gzipped under `data/raw/{source}/{date}/`
*before* validation, so any day can be re-normalized after an adapter fix.

## Secrets (.env)

- `SLEEPER_JWT` — Sleeper's internal GraphQL token. Grab it from the browser:
  sleeper.com → DevTools → Network → any `graphql` request → copy the
  `Authorization` header value (the bare JWT, no prefix). Expires ~1 year after
  issue and rotates if the Sleeper password changes; when GraphQL jobs start
  401ing, re-grab it.
- `FANTASYPROS_API_KEY` — from the FantasyPros subscriber API page. The
  fantasypros job skips gracefully (with a health warning) when unset.

## Operational notes

- Snapshots are sparse and append-only: a row is written only when a player's
  stat line actually changed (hash-diff). "Value as of date D" = latest row ≤ D.
- macOS sleep creates permanent archive holes. The worker runs a catch-up sweep
  on start (anacron semantics), but while the archive lives on a laptop, keep it
  awake (`caffeinate`) or move the worker to an always-on box.
- ROS projections = sum of weekly projections. The season-aggregate endpoint is
  mostly ADP-only (still ingested as week 0 — it carries Sleeper ADP for every
  format: ppr, 2qb, dynasty, rookie).
- `week = 0` in `projection_snapshots` means "season aggregate".
