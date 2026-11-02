FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/caller/package.json packages/caller/package.json
COPY packages/project/package.json packages/project/package.json
COPY packages/oasdiff/package.json packages/oasdiff/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN node scripts/install-oasdiff.mjs
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    CONTRACTGUARD_DATA_DIR=/app/data/analyses

COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core/package.json ./packages/core/package.json
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=builder /app/packages/caller/package.json ./packages/caller/package.json
COPY --from=builder /app/packages/caller/dist ./packages/caller/dist
COPY --from=builder /app/packages/caller/node_modules ./packages/caller/node_modules
COPY --from=builder /app/packages/project/package.json ./packages/project/package.json
COPY --from=builder /app/packages/project/dist ./packages/project/dist
COPY --from=builder /app/packages/project/node_modules ./packages/project/node_modules
COPY --from=builder /app/packages/oasdiff/package.json ./packages/oasdiff/package.json
COPY --from=builder /app/packages/oasdiff/dist ./packages/oasdiff/dist
COPY --from=builder /app/packages/oasdiff/node_modules ./packages/oasdiff/node_modules
COPY --from=builder /app/packages/mcp/package.json ./packages/mcp/package.json
COPY --from=builder /app/packages/mcp/dist ./packages/mcp/dist
COPY --from=builder /app/packages/mcp/node_modules ./packages/mcp/node_modules
COPY --from=builder /app/config/oasdiff-lock.json ./config/oasdiff-lock.json
COPY --from=builder /app/.tools ./.tools
COPY --from=builder /app/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
COPY --from=builder /app/third_party/oasdiff/LICENSE ./third_party/oasdiff/LICENSE
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/apps/cli/package.json ./apps/cli/package.json
COPY --from=builder /app/apps/cli/dist ./apps/cli/dist
COPY --from=builder /app/apps/cli/node_modules ./apps/cli/node_modules
COPY --from=builder /app/apps/web/dist ./apps/web/dist

RUN mkdir -p /app/data/analyses && chown -R node:node /app/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/index.js"]
