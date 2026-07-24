# posthog

Self-hosted [PostHog](https://posthog.com) (product analytics, session
replay, feature flags, surveys), hand-ported to Kubernetes from PostHog's
official-but-unsupported [Docker Compose "hobby" deploy](https://posthog.com/docs/self-host).

**Why hand-ported rather than a Helm chart**: PostHog
[sunset Kubernetes support](https://posthog.com/blog/sunsetting-helm-support-posthog)
in 2024 — the only vendor-supported self-host path today is Docker Compose on
a single VM. home-cloud only has a Kubernetes cluster, so this app recreates
the hobby stack's topology as chant-managed manifests instead. Expect more
manual care and feeding than a typical home-chant app: this mirrors exactly
the kind of multi-system complexity (Kafka, ClickHouse, Postgres, Redis)
PostHog itself cited when dropping K8s support.

Runs in its own `posthog` namespace (unlike most home-chant apps, which share
`default`) — set via this app's Flux `Kustomization` (`targetNamespace:
posthog` in home-cloud's `clusters/home/apps/home-chant.yaml`), not hardcoded
in source, consistent with the rest of home-chant's convention.

## Before first deploy

1. **Infisical secrets** (`src/secrets.ts`) — run the `/add-secret-via-infisical`
   skill in home-cloud to create the `posthog` project, a `posthog-operator`
   machine identity (Kubernetes-native auth, scoped to the
   `posthog-infisical` ServiceAccount), and two secret values:
   - `SECRET_KEY`: `head -c 28 /dev/urandom | sha224sum -b | head -c 56`
   - `ENCRYPTION_SALT_KEYS`: `openssl rand -hex 16` (never rotate on a live
     instance — invalidates already-encrypted data)

   Then replace the `REPLACE_ME_*` placeholders in `src/secrets.ts` with the
   identity ID and project slug the skill prints, rebuild
   (`npx chant build src --lexicon k8s --format yaml --output k8s/manifests.yaml`),
   and commit.
2. **Object storage bucket** — no manual step needed. `src/objectstorage.ts`'s
   bootstrap Job creates a `posthog` bucket + key in the existing Garage
   instance on first reconcile (same pattern as `k8s/loki/bootstrap-job.yaml`
   in home-cloud). Its cross-namespace exec RBAC is hand-authored in
   home-cloud at `k8s/posthog-bootstrap/bootstrap-rbac.yaml` (chant apps can't declare
   resources outside their own `targetNamespace`).
3. **DNS** — `highrise.inevitable.fyi` A record → cluster's static public IP
   (see home-cloud's `docs/deploying-apps.md` DNS section).

## What's included (v1 core scope)

Event capture, session replay, feature flags, surveys/remote-config, and
webhooks/CDP destinations. Backing services: Postgres (CNPG, two databases —
`posthog` and `posthog_persons`), Redis, ClickHouse + Zookeeper, Redpanda
(Kafka-API-compatible, topics auto-created), and Garage for object storage
(reused instead of standing up hobby's MinIO + SeaweedFS).

## Known v1 gaps

Dropped relative to the full hobby stack — each is an isolated add-on, not a
structural blocker, and can be layered in later:

- **AI/LLM observability** (`capture-ai`) — not deployed.
- **Logs/Traces products** (`capture-logs`, `ingestion-logs`,
  `ingestion-traces`) — not deployed.
- **Error Tracking** (`ingestion-error-tracking`, `cymbal`) — not deployed.
- **PDF/heatmap-screenshot exports** (`browserless`) — not deployed.
- **Live event counter** (`livestream`) — not deployed.
- **Temporal batch-export workflows, Cyclotron janitor** — not deployed;
  scheduled/long-running async jobs (e.g. data warehouse syncs) won't run.
- **Funnels insight type** — ClickHouse's `aggregate_funnel` and
  `json_drop_keys_udf` executable UDFs are precompiled, architecture-specific
  binaries checked into the posthog/posthog repo (aarch64/x86_64 variants).
  Not ported here; Funnels queries will error until these are added as a
  fast-follow matching the cluster's actual node architecture.
- **MaxMind GeoLite2 IP geolocation** for feature-flags — requires a MaxMind
  license key to download the database; not wired up. IP-based flag
  targeting degrades rather than failing.

## Source provenance

`src/assets/clickhouse/` is carried over byte-for-byte from
[posthog/posthog](https://github.com/posthog/posthog)'s
`docker/clickhouse/{config.xml,config.d/default.xml,users.xml,docker-entrypoint-initdb.d/init-db.sh}`
and `posthog/idl/*.json` — mounted verbatim into the ClickHouse ConfigMaps
rather than hand-translated, since the config itself doesn't need to change,
only where it's mounted from. `config.d/default.xml` and `config.xml`'s
`<zookeeper>` block hardcode the hostnames `clickhouse` and `zookeeper` —
those two Service names are load-bearing.
