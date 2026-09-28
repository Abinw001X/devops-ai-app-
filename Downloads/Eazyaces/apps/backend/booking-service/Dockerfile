FROM node:20-alpine AS build
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/backend/auth-service/package.json apps/backend/auth-service/package.json
COPY apps/backend/booking-service/package.json apps/backend/booking-service/package.json
RUN npm ci

COPY apps/backend/booking-service/ apps/backend/booking-service/
RUN npm run build --workspace=@kaamsetu/booking-service

FROM node:20-alpine AS production-dependencies
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/backend/auth-service/package.json apps/backend/auth-service/package.json
COPY apps/backend/booking-service/package.json apps/backend/booking-service/package.json
RUN npm ci --omit=dev --workspace=@kaamsetu/booking-service --include-workspace-root=false

FROM node:20-alpine AS production
ENV NODE_ENV=production
ENV PORT=4001
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /workspace/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /workspace/apps/backend/booking-service/package.json ./apps/backend/booking-service/package.json
COPY --from=build --chown=node:node /workspace/apps/backend/booking-service/dist ./apps/backend/booking-service/dist
USER node
EXPOSE 4001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4001/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "apps/backend/booking-service/dist/server.js"]