# Testing worker: Node + Playwright's Chromium. Build from the repository root:
#   docker build -f worker/Dockerfile -t nba-worker .
# The Playwright image tag must match the "playwright" version in worker/package.json.
FROM mcr.microsoft.com/playwright:v1.64.1-noble AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY worker/package.json worker/
RUN npm ci --workspace=shared --workspace=worker --include-workspace-root
COPY shared shared
COPY worker worker
RUN npm run build -w shared && npm run build -w worker && npm prune --omit=dev --workspace=shared --workspace=worker --include-workspace-root

FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
ENV NODE_ENV=production \
    CHROMIUM_NO_SANDBOX=true
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/worker/package.json ./worker/package.json
COPY --from=build /app/worker/dist ./worker/dist
USER pwuser
CMD ["node", "worker/dist/main.js"]
