# API server. Build from the repository root:
#   docker build -f api/Dockerfile -t nba-api .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY api/package.json api/
RUN npm ci --workspace=shared --workspace=api --include-workspace-root
COPY shared shared
COPY api api
RUN npm run build -w shared && npm run build -w api && npm prune --omit=dev --workspace=shared --workspace=api --include-workspace-root

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/api/package.json ./api/package.json
COPY --from=build /app/api/dist ./api/dist
USER node
EXPOSE 4000
CMD ["node", "api/dist/server.js"]
