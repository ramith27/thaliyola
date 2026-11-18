# Running Thaliyola on Kubernetes (several replicas, zero-downtime deploys)

This is how to run Thaliyola with two or more replicas on our EKS cluster, so that `kubectl rollout restart deployment thaliyola-main` (what CI runs on every deploy) and node drains don't drop requests.

The example below is a starting point, not a drop-in manifest. Keep your namespace, image, secrets, service account, ingress and resource sizes, and add the pieces marked **needed**.

## What the server does

| Endpoint / signal | Behaviour |
|---|---|
| `GET /livez` | 200 while the process answers. It never touches the database, so a database outage doesn't make Kubernetes restart every pod. Use it for the **liveness** and **startup** probes. |
| `GET /readyz` | 200 only when this replica should get traffic. It is 503 while starting, from SIGTERM on, and when Postgres doesn't answer `SELECT 1` within 2 seconds. Use it for the **readiness** probe and as the ALB target group's health check. |
| `GET /healthz` | Unchanged: database and embeddings status, for humans and the Docker `HEALTHCHECK`. |
| `SIGTERM` | Graceful shutdown (below), within `SHUTDOWN_TIMEOUT_SECONDS` (default 20). A second SIGTERM or SIGINT exits at once. |

The server listens only after migrations have run, so a pod that is migrating doesn't answer any probe. The startup probe below allows for that.

On SIGTERM, in this order:

1. `/readyz` turns 503, and responses on open keep-alive connections carry `Connection: close`.
2. Background jobs start no new runs.
3. Open live-refresh streams (`/api/events`) end. Browsers reconnect after 5 seconds, to another replica.
4. The server takes no new connections. In-flight requests (an MCP call, an import, an upload) get until the timeout to finish. Anything still running then is cut off.
5. Pending notification emails go out. Then a job run already in progress gets what's left of the timeout, minus up to 5 s kept back for the steps after it. A run can't be interrupted, so a long one (an advisory refresh) is cut off when its time is up; each job takes a Postgres advisory lock, so another replica (or the next run) redoes the work. Then the emails the job queued go out, the live-refresh listener stops, and the connection pool closes. A cut-off job may log a pool error as the pool closes under it.

The image's `CMD` is `node dist/index.js`, so Node is PID 1 and receives the signal directly. Don't wrap it in `sh -c` or `npm start`, because those don't pass SIGTERM on.

## What happens during a rollout

`kubectl rollout restart deployment thaliyola-main` with the settings below:

1. `maxSurge: 1, maxUnavailable: 0`: a new pod starts while both old ones keep serving.
2. The new pod runs migrations. Two pods starting together take turns through an advisory lock, and each migration is applied once. The new pod then listens, passes the startup probe, and becomes ready on `/readyz`. With the AWS Load Balancer Controller's pod readiness gate, it also waits until the ALB target is healthy.
3. One old pod is terminated:
   - Kubernetes removes it from the Service endpoints, and the controller starts deregistering it from the ALB.
   - At the same time, the `preStop` hook sleeps 10 s. The ALB and kube-proxy stop sending it new requests during that sleep.
   - Then SIGTERM arrives, and the pod drains for up to 20 s and exits.
4. The rollout repeats this for the next pod. The PodDisruptionBudget keeps at least one pod serving during node drains and cluster upgrades.

Time budget per pod: `preStop` (10 s) + `SHUTDOWN_TIMEOUT_SECONDS` (20 s) + 5 s margin ≤ `terminationGracePeriodSeconds` (45 s). If you raise one, raise the grace period too. Kubernetes sends SIGKILL when the grace period ends.

**Migrations must be backwards compatible.** During a rollout, old pods keep running against the new schema for a minute or two. Add columns and tables first, and remove or rename them in a later release, once no running version uses them (expand, then contract). A migration that drops something the old version reads causes errors during the rollout, not downtime, but avoid it.

## What is shared between replicas, and what stays per pod

| Thing | With 2+ replicas |
|---|---|
| Live page refresh (`/api/events`) | Every write calls `emitChanged()`. That tells this pod's open pages, and sends a Postgres `NOTIFY` on `thaliyola_changed`, at most one per 100 ms. Every pod `LISTEN`s and refreshes its own pages. The message says only that something changed, never what. A dropped listener reconnects every 5 s and refreshes pages once, in case it missed something. |
| Migrations | An advisory lock: one pod migrates, the others wait and then find nothing left to apply. |
| Maintenance (stale marking, expired sessions/OAuth/invitations/throttle rows), weekly digests, team sources, vulnerability re-checks, advisory feed | Each takes a Postgres advisory lock (`pg_try_advisory_lock`), so one replica at a time runs it. The others skip that run. Digests record `digest_sent_at` per person, and the security jobs record `job_runs`, so a second replica doesn't repeat them. |
| Embedding indexer | Each pod embeds pending chunks, taking them with `FOR UPDATE SKIP LOCKED`, so no chunk is embedded twice. |
| Sessions, API tokens, OAuth clients, requests, codes and tokens, invitations, lockfile upload links, docs runs | In Postgres. An OAuth code issued by one pod can be redeemed on another. |
| Sign-in and invitation throttling | In Postgres (`auth_throttle`, migration 036): one count for every replica, kept across deploys. Rows store an unsalted SHA-256 of the email and address rather than the values. That keeps them out of plain sight but isn't anonymous: someone with database access can recover an IPv4 address by trying them all, or check a guessed email and address. The maintenance job deletes rows once their 15 minutes are up. |
| Per-user rate limit (`RATE_LIMIT_PER_MINUTE`) | Per pod, in memory. With N replicas someone can get up to N times the budget. It is a safety valve against runaway agent loops, not a quota. Divide it by the replica count if you want the old total. |
| System settings changed by admins | Stored in Postgres. Every pod reloads them every 30 s. |
| PDF text cache, MCP tool catalog, mail transport | Per-pod caches of content-addressed or static data. A miss costs a little CPU, nothing else. |
| Embedding model (`EMBEDDINGS=local`) | Each pod loads its own copy, and downloads it into `EMBEDDING_CACHE_DIR` on first start. Until it's loaded, that pod's searches are keyword-only. Readiness doesn't wait for it. |
| **Uploaded files** | **Needed:** `ASSET_STORE=s3` (S3, R2 or MinIO; the S3 client signs with `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`, so give it an IAM user's keys in the secret). The default local disk (`ASSET_DIR`) is per pod, so a file uploaded through one pod would be missing on the others. Alternatively, mount the same ReadWriteMany volume (EFS) at `ASSET_DIR` on every pod. |

### Connections

Each pod's pool opens at most 10 Postgres connections. One of them is held for `LISTEN`, and a migrating pod uses one more for the lock. Plan for `replicas × 11`, plus one extra pod's worth during a rollout, under RDS's `max_connections`.

Point `DATABASE_URL` at Postgres directly (RDS), or at a pooler in session mode. PgBouncer in transaction mode breaks `LISTEN/NOTIFY` and session advisory locks. RDS Proxy pins the listening connection, which works but takes one proxy connection per pod.

### Client addresses behind the ALB

Sign-in throttling counts failures per client address. Behind the ALB, the address the pod sees is the load balancer's. Set `TRUST_PROXY=1`: the ALB is exactly one hop in front of the pods, so the server takes the client address the ALB appended to `X-Forwarded-For`, which a client can't forge. Otherwise every visitor shares one count, and 50 failed sign-ins from anyone lock everyone out for 15 minutes. If another proxy sits between the ALB and the server (an ingress controller or a sidecar that adds to `X-Forwarded-For`), count it too (`2`). `TRUST_PROXY` also takes `true` or a comma-separated list of addresses and CIDR ranges (`loopback`, `uniquelocal`, ...), but don't use `true` or `uniquelocal` here. `true` believes any `X-Forwarded-For`. `uniquelocal` believes every hop with a private address, so any client on a private address (another pod in the cluster, someone on the VPN or a peered network, or everyone if the ALB is internal) can put its own address in `X-Forwarded-For`, change it on every attempt, and guess passwords for one account without ever being throttled. Also set `COOKIE_SECURE=true`, because TLS ends at the ALB.

## Example

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thaliyola-main
  labels: { app: thaliyola }
spec:
  replicas: 2
  revisionHistoryLimit: 5
  selector:
    matchLabels: { app: thaliyola }
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1          # start the new pod first
      maxUnavailable: 0    # never go below 2 ready pods
  template:
    metadata:
      labels: { app: thaliyola }
    spec:
      terminationGracePeriodSeconds: 45   # preStop 10 + SHUTDOWN_TIMEOUT_SECONDS 20 + margin
      # Spread the pods over nodes and zones, so one node or AZ going away leaves one serving.
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector: { matchLabels: { app: thaliyola } }
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector: { matchLabels: { app: thaliyola } }
      containers:
        - name: server
          image: <account>.dkr.ecr.<region>.amazonaws.com/thaliyola:<tag>
          ports:
            - { name: http, containerPort: 8080 }
          envFrom:
            - secretRef: { name: thaliyola-env }   # DATABASE_URL, S3_*, SMTP_URL, tokens, ...
          env:
            - { name: PUBLIC_URL, value: "https://thaliyola.example.com" }
            - { name: ASSET_STORE, value: "s3" }              # needed with 2+ replicas
            - { name: TRUST_PROXY, value: "1" }               # the ALB is one hop: use the address it appends
            - { name: COOKIE_SECURE, value: "true" }
            - { name: SHUTDOWN_TIMEOUT_SECONDS, value: "20" }
            - { name: EMBEDDING_CACHE_DIR, value: "/data/models" }
          lifecycle:
            preStop:
              # Keep serving while the ALB and kube-proxy stop routing here; SIGTERM comes after.
              exec: { command: ["sleep", "10"] }
          startupProbe:
            # Covers migrations (the server listens only after them): up to 5 minutes.
            httpGet: { path: /livez, port: http }
            periodSeconds: 5
            failureThreshold: 60
          livenessProbe:
            httpGet: { path: /livez, port: http }
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          readinessProbe:
            httpGet: { path: /readyz, port: http }
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 2
          resources:
            requests: { cpu: 250m, memory: 768Mi }
            limits: { memory: 1536Mi }
          volumeMounts:
            - { name: models, mountPath: /data/models }
      volumes:
        - name: models
          emptyDir: {}     # the embedding model, downloaded once per pod
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: thaliyola-main
spec:
  minAvailable: 1          # node drains and upgrades take one pod at a time
  selector:
    matchLabels: { app: thaliyola }
---
apiVersion: v1
kind: Service
metadata:
  name: thaliyola-main
spec:
  selector: { app: thaliyola }
  ports:
    - { name: http, port: 80, targetPort: http }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: thaliyola-main
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/healthcheck-path: /readyz
    alb.ingress.kubernetes.io/healthcheck-interval-seconds: "5"
    alb.ingress.kubernetes.io/healthy-threshold-count: "2"
    alb.ingress.kubernetes.io/unhealthy-threshold-count: "2"
    # Shorter than preStop + drain, so the ALB has let go before the pod exits.
    alb.ingress.kubernetes.io/target-group-attributes: deregistration_delay.timeout_seconds=25
    # Live refresh streams send a ping every 25 s; keep the idle timeout above that.
    alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=120
spec:
  ingressClassName: alb
  rules:
    - host: thaliyola.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: { name: thaliyola-main, port: { name: http } }
```

With `target-type: ip`, turn on the AWS Load Balancer Controller's [pod readiness gate](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/deploy/pod_readiness_gate/) for the namespace (`kubectl label namespace <ns> elbv2.k8s.aws/pod-readiness-gate-inject=enabled`). Then a rollout waits until the new pod is healthy in the ALB, not only in Kubernetes, before it terminates an old one.

## Checking a deploy

```sh
kubectl rollout restart deployment thaliyola-main
kubectl rollout status deployment thaliyola-main
# Meanwhile, from another terminal: no errors expected.
while true; do curl -s -o /dev/null -w '%{http_code}\n' https://thaliyola.example.com/readyz; sleep 0.2; done
```

A terminating pod logs `[shutdown] SIGTERM: draining for up to 20 s`, then `[shutdown] done`. If it logs `requests still running when time was up were cut off` or `still running when time was up`, raise `SHUTDOWN_TIMEOUT_SECONDS` together with `terminationGracePeriodSeconds`.

## Ops checklist for `thaliyola-main` (1.1.0)

Two changes live outside this repository: the shared CI (`cap_tech1/ci-scripts`, included by `.gitlab-ci.yml`) and the `thaliyola-main` manifests. Nothing in this repository changes them; these are the exact steps for the ops team.

### 1. Pass `BUILD_SHA` to the image build

Without it `/healthz`, `GET /api/version` and Help › About report `"commit": null` (the Docker build context has no `.git`). The Dockerfile already takes it (`ARG BUILD_SHA`, and `ARG CI_COMMIT_SHA` as a fallback).

1. Open `cap_tech1/ci-scripts` › `general-ci/ci.yml` and find the Kaniko job (`/kaniko/executor …`). Check whether it appends a variable such as `$KANIKO_BUILD_ARGS` (or `$BUILD_ARGS`) to the executor's arguments.
2. **If it does:** in this project, Settings › CI/CD › Variables › Add variable:
   - Key: `KANIKO_BUILD_ARGS` (the name the template uses)
   - Value: `--build-arg BUILD_SHA=$CI_COMMIT_SHA`
   - Untick *Protect variable* if deploys run from unprotected branches; untick *Mask variable* (it isn't a secret) and leave *Expand variable reference* ticked, so `$CI_COMMIT_SHA` is expanded when the job runs.
3. **If it doesn't:** ask the CI owners to add `$KANIKO_BUILD_ARGS` (empty by default) to the executor line, for example
   `/kaniko/executor --context "$CI_PROJECT_DIR" --dockerfile "$DOCKERFILE" --destination "$IMAGE" $KANIKO_BUILD_ARGS`,
   or to pass `--build-arg CI_COMMIT_SHA=$CI_COMMIT_SHA` for every project (harmless for images that don't declare the argument). Then do step 2.
4. Check after the next deploy: `curl -s https://<thaliyola-host>/healthz` shows `"version": "1.1.0"` and `"commit"` equal to the deployed commit.

### 2. Run `thaliyola-main` as two replicas

Do these in order. Step a must be live before the second pod starts, or files uploaded through one pod are missing on the other.

a. **Uploaded files to S3.** Create a bucket (or a prefix in an existing one) and an IAM user (or IRSA role) with `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on it. Add to the `thaliyola-env` secret: `S3_ENDPOINT` (`https://s3.<region>.amazonaws.com`), `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, optionally `S3_PREFIX`, and `S3_PATH_STYLE=false` for AWS. Copy what's on the current pod's disk; the keys are the same on disk and in S3:

```sh
POD=$(kubectl get pod -l app=thaliyola -o jsonpath='{.items[0].metadata.name}')
kubectl cp "$POD":/data/assets ./thaliyola-assets          # ASSET_DIR on the pod
aws s3 sync ./thaliyola-assets "s3://$S3_BUCKET/${S3_PREFIX:+$S3_PREFIX/}"
```

b. **The deployment.** Against the current single-replica manifest, the change is (keep your image, secret, service account and resources):

```diff
 spec:
-  replicas: 1
+  replicas: 2
+  strategy:
+    type: RollingUpdate
+    rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }
   template:
     spec:
+      terminationGracePeriodSeconds: 45
+      topologySpreadConstraints:
+        - { maxSkew: 1, topologyKey: kubernetes.io/hostname, whenUnsatisfiable: ScheduleAnyway, labelSelector: { matchLabels: { app: thaliyola } } }
       containers:
         - name: server
           env:
+            - { name: ASSET_STORE, value: "s3" }
+            - { name: TRUST_PROXY, value: "1" }
+            - { name: COOKIE_SECURE, value: "true" }
+            - { name: SHUTDOWN_TIMEOUT_SECONDS, value: "20" }
+          lifecycle:
+            preStop: { exec: { command: ["sleep", "10"] } }
+          startupProbe: { httpGet: { path: /livez, port: http }, periodSeconds: 5, failureThreshold: 60 }
+          livenessProbe: { httpGet: { path: /livez, port: http }, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 }
+          readinessProbe: { httpGet: { path: /readyz, port: http }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 2 }
+---
+apiVersion: policy/v1
+kind: PodDisruptionBudget
+metadata: { name: thaliyola-main }
+spec: { minAvailable: 1, selector: { matchLabels: { app: thaliyola } } }
```

If the manifest already has some of these (probes, `TRUST_PROXY`), keep one copy. Remove any `ReadWriteOnce` volume mounted at `ASSET_DIR`: it can't be mounted by two pods, and S3 replaces it. On the ingress, point the ALB health check at `/readyz` and set `deregistration_delay.timeout_seconds=25` (see the example above).

c. **Database connections.** Two pods open up to 22 Postgres connections, 33 during a rollout. Check that RDS `max_connections` leaves room for that.

d. **Check it.** `kubectl rollout status deployment thaliyola-main`, then upload a screenshot to an article and open it a few times (the ALB alternates pods), and run the readiness loop from "Checking a deploy" during a `kubectl rollout restart`.

### 3. The claude-skills source and its webhook (after 1.1.0 is live)

1. Skills › Import skills › Connect a repository: GitLab, `cap_tech1/ai-tools/claude-skills`, ref `master`, exclude `plugins/im-knowledge-base/**`, import for reviewers only `evals/**` and `tasks/**`, and a GitLab token with `read_repository` (stored encrypted with `CONNECTIONS_KEY`). `git.cap-cloud.co` is self-hosted: list it in `SKILLS_GIT_HOSTS` (it may resolve to a private address), and make sure the pod can reach it.
2. On the source's page, **Make a secret**. In GitLab, the project's Settings › Webhooks › Add new webhook: the URL shown there (`https://<thaliyola-host>/api/skill-sources/<id>/webhook`), the secret as *Secret token*, trigger *Push events* on `master`, SSL verification on. GitLab's *Test › Push events* should answer 202. Behind Cloudflare Access, let `/api/skill-sources/*/webhook` through with a bypass policy (the secret is the credential).
