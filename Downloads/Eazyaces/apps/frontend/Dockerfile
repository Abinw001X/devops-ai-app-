FROM node:20-alpine AS build
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/backend/auth-service/package.json apps/backend/auth-service/package.json
COPY apps/backend/booking-service/package.json apps/backend/booking-service/package.json
RUN npm ci

COPY . .
ARG NEXT_PUBLIC_API_URL=/api
ARG NEXT_PUBLIC_BOOKING_API_URL=/api
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID=
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL:-/api}
ENV NEXT_PUBLIC_BOOKING_API_URL=${NEXT_PUBLIC_BOOKING_API_URL:-/api}
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=${NEXT_PUBLIC_GOOGLE_CLIENT_ID}
RUN npm run build --workspace=apps/frontend

FROM node:20-alpine AS production
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /workspace/apps/frontend/.next/standalone/ ./
COPY --from=build --chown=node:node /workspace/apps/frontend/.next/static/ ./apps/frontend/.next/static/
COPY --from=build --chown=node:node /workspace/apps/frontend/public/ ./apps/frontend/public/
WORKDIR /app/apps/frontend
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server.js"]