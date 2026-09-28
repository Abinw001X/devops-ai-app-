# KaamSetu

KaamSetu is a two-sided local services marketplace. This workspace includes customer/provider onboarding and search (Phase 1), bookings and Razorpay payments (Phase 2), subscriptions and payout requests (Phase 3), and the admin operations area plus notifications (Phase 4).

## Requirements

- Node.js 20.9 or newer
- PostgreSQL 14 or newer

## Local Setup

1. Create a PostgreSQL database named `kaamsetu` and set `DATABASE_URL` in both backend service environment files.
2. Apply the schemas in this order from the repository root:

   ```sh
   psql "$DATABASE_URL" -f apps/backend/auth-service/src/db/schema.sql
   psql "$DATABASE_URL" -f apps/backend/booking-service/src/db/schema.sql
   ```

   The booking schema adds booking, payment, dispute, notification, and payout workflow changes to the shared database.

3. Copy each service's `.env.example` to `.env`, and `apps/frontend/.env.example` to `apps/frontend/.env.local`.
4. Set the same random `JWT_ACCESS_SECRET` (at least 32 characters) in both services. Set the same random `INTERNAL_SERVICE_SECRET` in both services; keep `NOTIFICATION_SERVICE_URL=http://localhost:4001` in the auth service. The booking service hosts Socket.IO and receives verification events at this internal URL.
5. Set a temporary `ADMIN_BOOTSTRAP_KEY` in the auth service. Optionally configure matching Google OAuth client IDs for the frontend and auth service.
6. Run `npm install` from the repository root.
7. Start all three processes in separate terminals:

   ```sh
   npm run dev:auth
   npm run dev:bookings
   npm run dev:frontend
   ```

   The auth API listens on port 4000, the booking API and Socket.IO server on port 4001, and Next.js on port 3000. There is no separate notification process.

## Admin Access

Create the first administrator through the protected bootstrap endpoint. Use the configured bootstrap key and a unique email/password:

```sh
export ADMIN_BOOTSTRAP_KEY='<the temporary key configured in auth-service/.env>'
curl -X POST http://localhost:4000/api/auth/admin/bootstrap \
  -H "x-admin-bootstrap-key: $ADMIN_BOOTSTRAP_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"KaamSetu Admin","email":"admin@example.com","password":"change-this-password"}'
unset ADMIN_BOOTSTRAP_KEY
```

Open [http://localhost:3000/admin/login](http://localhost:3000/admin/login). Admin accounts cannot use the public login endpoint or public signup flow. After creating the administrator, remove `ADMIN_BOOTSTRAP_KEY` from the auth service environment and restart that service.

## Phase 4 Workflows

- Register a provider with a KYC document. Review it in **Verification queue**. Approval marks it verified; the listing becomes live only after an active subscription as well.
- Sign in as a customer, book and pay for a provider, then open **My bookings** and the booking details page to raise a dispute. Sign in as the provider in another browser/session to see the provider booking list and dispute status.
- Use the admin **Disputes** queue to inspect booking/payment details and resolve a ticket. Full/partial customer refunds use the Razorpay refund API; provider releases use RazorpayX.
- Provider payout requests remain pending until an administrator selects **Approve & send payout**. Rejections require a reason. Money-moving decisions are written to `admin_actions_log`.
- The notification bell receives persisted in-app events over Socket.IO. Configure `RESEND_API_KEY` and `RESEND_FROM_EMAIL` in the booking service to send plain-text critical emails. Without them, email is skipped. SMS/Twilio is intentionally an interface stub.

To exercise live payments, configure Razorpay test keys and a webhook secret in the booking service. To exercise actual payout calls, configure RazorpayX credentials and `RAZORPAYX_ACCOUNT_NUMBER`; leave these unset to keep outbound payouts disabled. Configure Razorpay webhooks to reach `http://localhost:4001/api/payments/webhook` for payment, refund, and payout updates.

## Build

```sh
npm run build
npm run lint --workspace=apps/frontend
```

## Phase 5 Containers

Production Dockerfiles and GHCR publishing are provided for the existing `frontend`, `auth-service`, and `booking-service` workspaces. The booking image includes the payment endpoints and Socket.IO notification service because those are co-located in this codebase; there are no separate payment or notification service packages to publish as independent images.

Continue developing directly with Node.js/npm on an M1 Mac. Docker Compose is optional and does not start unless explicitly requested with `docker compose --profile optional-stack up --build`.

## Phase 6 Cloud Deployment

Provider-neutral Kustomize base and `dev`, `staging`, and `prod` overlays live under [infra/k8s](infra/k8s/README.md). They describe the frontend, auth-service, and booking-service; payments and notifications remain endpoints inside booking-service. The `.github/workflows/pr-validation.yml` workflow validates builds and renders the overlays without a cluster. Main-branch image publication can promote the exact SHA images to staging; production is gated by GitHub Environment approval in `.github/workflows/cloud-deploy.yml`.

**Local:** Node.js/npm, Git, and optional Docker. Direct Node development is recommended; full Docker Compose remains opt-in. No local Kubernetes, ingress, database, Redis, or monitoring workloads are required.

**Cloud:** Managed Kubernetes, ingress/TLS, managed PostgreSQL and Redis, S3-compatible object storage, secret management, and optional monitoring. Configure all cloud resources manually, then provide staging/production GitHub environment settings. See [DEPLOYMENT.md](DEPLOYMENT.md) for setup steps, exact variables, rollout checks, sizing assumptions, and rollback commands. Kubernetes commands in that guide target cloud clusters only.
