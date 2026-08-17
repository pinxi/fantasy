# Single image runs BOTH processes (worker + web) on one machine so they share
# the SQLite volume — matches the single-writer design (worker writes, web reads).
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
# better-sqlite3 compiles from source
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# The root layout queries source_health at build-time prerender (404 page), so
# the builder needs a migrated (empty) throwaway db before `next build`.
RUN pnpm db:migrate && pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml next.config.ts tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
EXPOSE 3000
CMD ["./entrypoint.sh"]
