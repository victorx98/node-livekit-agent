# Kubernetes manifests

`deployment.yaml` is the production Deployment + internal Service for the
interview-agent worker (§18–§20). It is intentionally a single, commented
manifest rather than a templating setup — adjust the inline values for your
environment.

## Before applying

1. Build and push the image, then set `spec.template.spec.containers[0].image`.
2. Create the referenced config and secrets:

   ```bash
   kubectl create configmap interview-agent-config \
     --from-env-file=.env.tuning        # non-secret tuning (DEFAULT_VOICE, RECORDING_*, ...)

   kubectl create secret generic interview-agent-secrets \
     --from-literal=LIVEKIT_URL=... \
     --from-literal=LIVEKIT_API_KEY=... \
     --from-literal=LIVEKIT_API_SECRET=... \
     --from-literal=OPENAI_API_KEY=... \
     --from-literal=GOOGLE_API_KEY=... \
     --from-literal=AWS_REGION=... \
     --from-literal=AWS_ACCESS_KEY_ID=... \
     --from-literal=AWS_SECRET_ACCESS_KEY=... \
     --from-literal=RECORDING_S3_BUCKET=... \
     --from-literal=REDIS_URL=... \
     --from-literal=WEBHOOK_URL=...
   ```

3. Recompute `replicas` and `MAX_CONCURRENT_INTERVIEWS` from your load test
   (§18 worksheet: `replicas = ceil((P / C) * H)`).

## Production vs dev/staging

The manifest ships with **production** drain settings so a rollout never kills a
live interview:

- `terminationGracePeriodSeconds: 4200` (70 min) and `DRAIN_TIMEOUT_SECONDS=3900`
  (65 min) — both greater than the 59-minute max interview.
- `rollingUpdate: maxUnavailable=0, maxSurge=1`.

For **dev/staging**, interrupting test interviews is fine, so iterate fast:

```yaml
terminationGracePeriodSeconds: 60
env:
  - name: DRAIN_TIMEOUT_SECONDS
    value: "30"
```

> Trade-off (decide explicitly): the long prod drain means a full rollout can
> take up to ~70 min. Given autonomous 1-hour interviews, draining is the right
> call for prod; schedule deploys for low-traffic windows.

## Probes and ports

- `8080` — our monitoring API: `/healthz` (liveness), `/readyz` (readiness;
  flips to 503 on SIGTERM so the LB drains the replica), `/jobs`, `/jobs/:id`,
  `POST /jobs/:id/cancel`.
- `8081` — the LiveKit framework's built-in health/worker server.

The Service is `ClusterIP` (internal only); the monitoring API is private by
design and must not be exposed publicly.
