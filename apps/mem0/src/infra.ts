import {
  Cluster,
  Container,
  Deployment,
  PersistentVolumeClaim,
  Probe,
} from "@intentius/chant-lexicon-k8s";
import { TraefikApp, TraefikEndpoint } from "@home-chant/traefik-app";
import { params } from "@intentius/chant/params";

const name = "mem0";
const apiHost = `${name}.${params.domain}`;
const dashboardHost = `${name}-ui.${params.domain}`;
const apiPort = 8000;
const dashboardPort = 3000;
const dashboardName = `${name}-dashboard`;

// mem0 is the one app with two public surfaces in a single namespace, so it
// uses both halves of the composite: TraefikApp for the API (which also brings
// the Namespace and the Infisical identity pair), and TraefikEndpoint for the
// dashboard, which shares both. Deployments below are hand-written — see the
// composite's own comment for why workloads stay out of it.
//
// The materialized `mem0-secrets` Secret holds OPENAI_API_KEY, JWT_SECRET and
// ADMIN_API_KEY, which the API Deployment consumes via envFrom.
const app = TraefikApp({
  name,
  host: apiHost,
  port: apiPort,
  issuer: params.issuer as string,
  infisical: {
    identityId: "ca535f2a-a3f9-42f2-9ffe-3b369e496519",
    projectSlug: "mem0-wzd-g",
    secretName: `${name}-secrets`,
  },
});

export const {
  namespace,
  serviceAccount,
  secret,
  service,
  certificate,
  ingressRoute,
  ingressRouteHttp,
} = app;

const labels = app.labels;

const dashboard = TraefikEndpoint({
  name: dashboardName,
  host: dashboardHost,
  port: dashboardPort,
  issuer: params.issuer as string,
});

export const dashboardService = dashboard.service;
export const dashboardCertificate = dashboard.certificate;
export const dashboardIngressRoute = dashboard.ingressRoute;
export const dashboardIngressRouteHttp = dashboard.ingressRouteHttp;

const dashboardLabels = dashboard.labels;

// Postgres backend. Holds both app state (users, request logs, memory history
// rows) AND the pgvector-backed memory embeddings — the upstream mem0 server
// uses the same database for both.
//
// `imageName` pins the CNPG "standard" image variant, which ships pgvector
// preinstalled (the default minimal variant does not). `postInitTemplateSQL`
// installs the extension into template1 as superuser before the app DB is
// created from that template, so the app user inherits it without needing
// superuser privileges itself.
//
// Single instance — for a personal memory store, Longhorn-level replication is
// enough. Bump `instances` to 3 later if Postgres-level HA matters more than the
// storage cost.
export const postgres = new Cluster({
  metadata: { name: `${name}-pg` },
  spec: {
    instances: 1,
    imageName: "ghcr.io/cloudnative-pg/postgresql:17.6-standard-trixie",
    bootstrap: {
      initdb: {
        database: "mem0_app",
        owner: name,
        postInitTemplateSQL: ["CREATE EXTENSION IF NOT EXISTS vector;"],
      },
    },
    storage: { storageClass: "longhorn", size: "10Gi" },
    resources: {
      requests: { cpu: "50m", memory: "256Mi" },
      limits: { memory: "512Mi" },
    },
  },
});

// mem0 server writes a SQLite `history.db` to /app/history/ for the per-memory
// audit log (separate from the pgvector-backed embeddings in Postgres). SQLite
// is single-writer, so RWO + Recreate strategy on the Deployment.
export const historyVolume = new PersistentVolumeClaim({
  metadata: { name: `${name}-history` },
  spec: {
    accessModes: ["ReadWriteOnce"],
    storageClassName: "longhorn",
    resources: { requests: { storage: "1Gi" } },
  },
});

// Postgres connection — used both for app state (db.py via APP_DB_NAME) and as
// the pgvector store (main.py via POSTGRES_DB). Both point at the same database;
// the pgvector collection lives in its own table.
const pgSecret = `${name}-pg-app`;
const pgEnv = [
  { name: "POSTGRES_HOST", valueFrom: { secretKeyRef: { name: pgSecret, key: "host" } } },
  { name: "POSTGRES_PORT", valueFrom: { secretKeyRef: { name: pgSecret, key: "port" } } },
  { name: "POSTGRES_USER", valueFrom: { secretKeyRef: { name: pgSecret, key: "username" } } },
  { name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: pgSecret, key: "password" } } },
  { name: "POSTGRES_DB", valueFrom: { secretKeyRef: { name: pgSecret, key: "dbname" } } },
  { name: "APP_DB_NAME", valueFrom: { secretKeyRef: { name: pgSecret, key: "dbname" } } },
];

export const deployment = new Deployment({
  metadata: {
    name,
    labels,
    annotations: {
      // Roll the pod when the Infisical operator rotates mem0-secrets — mem0
      // reads env vars at startup, so a Secret update without a restart is
      // silently ignored.
      "secrets.infisical.com/auto-reload": "true",
    },
  },
  spec: {
    replicas: 1,
    // SQLite history.db is single-writer and the PVC is RWO. A rolling update
    // would deadlock waiting for the old pod to release the volume.
    strategy: { type: "Recreate" },
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        containers: [
          new Container({
            name,
            // Built from upstream mem0ai/mem0 at the pinned tag by
            // .github/workflows/build-mem0-server.yml — there is no official
            // prebuilt image for the server. The `v2.0.2` tag is mutable
            // (rebuilt by the workflow on any fix commit), so IfNotPresent would
            // keep nodes pinned to a stale digest. Always forces a manifest
            // check on every pod start, which is cheap against public GHCR.
            image: "ghcr.io/jhgaylor/mem0-server:v2.0.2",
            imagePullPolicy: "Always",
            // The upstream Dockerfile sets CMD with `--reload`, a dev-only file
            // watcher. Override here so we run alembic migrations on every start
            // (idempotent) then a clean uvicorn.
            command: ["sh", "-c"],
            args: [
              "alembic upgrade head && uvicorn main:app --host 0.0.0.0 --port 8000",
            ],
            workingDir: "/app",
            ports: [{ containerPort: apiPort, name: "http" }],
            env: [
              ...pgEnv,
              { name: "POSTGRES_COLLECTION_NAME", value: "memories" },
              { name: "HISTORY_DB_PATH", value: "/app/history/history.db" },
              { name: "MEM0_TELEMETRY", value: "false" },
              { name: "AUTH_DISABLED", value: "false" },
              // CORS allow-list for the dashboard origin. The server adds this
              // exact value to its FastAPI CORS middleware; a mismatch means the
              // browser blocks every dashboard XHR.
              { name: "DASHBOARD_URL", value: `https://${dashboardHost}` },
            ],
            envFrom: [{ secretRef: { name: `${name}-secrets` } }],
            volumeMounts: [{ name: "history", mountPath: "/app/history" }],
            resources: {
              requests: { cpu: "100m", memory: "256Mi" },
              limits: { memory: "1Gi" },
            },
            readinessProbe: new Probe({
              httpGet: { path: "/openapi.json", port: "http" },
              initialDelaySeconds: 10,
              periodSeconds: 10,
            }),
            livenessProbe: new Probe({
              httpGet: { path: "/openapi.json", port: "http" },
              initialDelaySeconds: 30,
              periodSeconds: 30,
            }),
          }),
        ],
        volumes: [
          {
            name: "history",
            persistentVolumeClaim: { claimName: `${name}-history` },
          },
        ],
      },
    },
  },
});

export const dashboardDeployment = new Deployment({
  metadata: { name: dashboardName, labels: dashboardLabels },
  spec: {
    replicas: 1,
    // Stateless Next.js, but kept single-replica + Recreate because at this
    // scale there's no benefit to rolling and HPA would be silly.
    strategy: { type: "Recreate" },
    selector: { matchLabels: dashboardLabels },
    template: {
      metadata: { labels: dashboardLabels },
      spec: {
        containers: [
          new Container({
            name: "dashboard",
            // Built from upstream mem0ai/mem0 server/dashboard at the pinned tag
            // by .github/workflows/build-mem0-dashboard.yml.
            image: "ghcr.io/jhgaylor/mem0-dashboard:v2.0.2",
            // Mutable tag (rebuilt on workflow fixes), so Always rather than
            // IfNotPresent.
            imagePullPolicy: "Always",
            ports: [{ containerPort: dashboardPort, name: "http" }],
            env: [
              // The dashboard is a Next.js app: browser-side fetches hit
              // NEXT_PUBLIC_API_URL (must be a browser-resolvable FQDN, baked
              // into static bundles at build time and substituted at container
              // start by entrypoint.sh); SSR + API-route proxying inside the
              // dashboard pod uses API_INTERNAL_URL (cluster DNS).
              { name: "NEXT_PUBLIC_API_URL", value: `https://${apiHost}` },
              {
                name: "API_INTERNAL_URL",
                value: `http://${name}.${name}.svc.cluster.local:${apiPort}`,
              },
              { name: "NEXT_PUBLIC_INSTANCE_NAME", value: "home-cloud" },
            ],
            resources: {
              requests: { cpu: "50m", memory: "128Mi" },
              limits: { memory: "512Mi" },
            },
            readinessProbe: new Probe({
              httpGet: { path: "/", port: "http" },
              initialDelaySeconds: 10,
              periodSeconds: 10,
            }),
            livenessProbe: new Probe({
              httpGet: { path: "/", port: "http" },
              initialDelaySeconds: 30,
              periodSeconds: 30,
            }),
          }),
        ],
      },
    },
  },
});
