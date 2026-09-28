# Kubernetes Configuration

This directory contains provider-neutral Kustomize configuration. It is configuration only and is never applied to a local cluster by repository scripts or CI.

```text
infra/k8s/
  base/                 Shared Namespace, ConfigMap, Deployments, Services, probes, Ingress and booking HPA
  base/payment-service/ Payment API consolidation note; no independent workload exists
  base/notification-service/ Notification API consolidation note; no independent workload exists
  overlays/dev/         One replica per app; lower booking HPA ceiling
  overlays/staging/     Two app replicas; booking HPA enabled
  overlays/prod/         Higher replicas and resource requests/limits
  monitoring/           Optional Prometheus scrape snippet
```

Run `kustomize build infra/k8s/overlays/dev` (and staging/prod) for static rendering. The pull-request workflow runs these builds on GitHub-hosted runners; no cluster is contacted.

The checked-in `base/secret.template.yaml` is deliberately excluded from Kustomize resources. It contains placeholders only. Create `kaamsetu-secrets` from a cloud secret manager or the template copied outside the repo before deploying. Never commit the populated Secret. The ConfigMap contains a placeholder cloud object bucket and example domains; replace them in each overlay before cloud rollout.

The image names use a non-functional owner/repository placeholder. `cloud-deploy.yml` rewrites them to the current repository's immutable SHA-tagged GHCR images before applying an overlay.

All app Services are `ClusterIP`. Only Ingress is public. The `/api` catchall and `/socket.io` route point to booking-service; auth-owned more-specific paths (`/api/auth`, `/api/profiles`, `/api/admin/providers`, `/media/profiles`) route to auth-service. A cloud ingress controller, DNS records, TLS Secret, and cert-manager Issuer are cloud prerequisites.

There is no independent payment or notification process in the application workspaces. Do not create duplicate Deployments or HPAs for them: `/api/payments`, `/api/notifications`, and Socket.IO are all handled by booking-service. Extract those domains in a future application phase before deploying them independently.

CPU/memory values are starting estimates. Adjust from cloud monitoring, load tests, and observed request/resource usage. HPA requires the cluster Metrics Server. Managed PostgreSQL, Redis, and S3-compatible storage are external production dependencies.
