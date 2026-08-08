import {
  Certificate,
  Cluster,
  Container,
  Deployment,
  InfisicalSecret,
  IngressRoute,
  Namespace,
  PersistentVolumeClaim,
  Probe,
  Service,
  ServiceAccount,
} from "@intentius/chant-lexicon-k8s";

const name = "mem0";
const apiHost = "mem0.inevitable.fyi";
const dashboardHost = "mem0-ui.inevitable.fyi";
const apiPort = 8000;
const dashboardPort = 3000;
const labels = { app: name };
const dashboardName = `${name}-dashboard`;
const dashboardLabels = { app: dashboardName };

// Namespaced resources deliberately carry no `metadata.namespace` — the Flux
// Kustomization in home-cloud sets `targetNamespace: mem0` (chant's WK8001 flags
// hardcoded namespaces in source). The Namespace object itself survives that
// transform unchanged, so this is still what creates the namespace.
export const namespace = new Namespace({ metadata: { name } });

// Identity the secrets-operator presents to Infisical for the InfisicalSecret
// below (kubernetesAuth). The `mem0-operator` machine identity on the server is
// restricted to exactly this ServiceAccount + namespace; the operator mints
// short-lived tokens for it.
export const serviceAccount = new ServiceAccount({
  metadata: { name: `${name}-infisical` },
});

// Materializes a Secret named `mem0-secrets` holding OPENAI_API_KEY, JWT_SECRET
// and ADMIN_API_KEY, which the Deployment consumes via envFrom. The namespaces
// below are spec fields, not `metadata.namespace`, so the Flux namespace
// transform does not rewrite them.
export const secrets = new InfisicalSecret({
  metadata: { name: `${name}-secrets` },
  spec: {
    // Internal Service DNS — no Traefik/Cloudflare round-trip for in-cluster
    // reconciles.
    hostAPI: "http://infisical.infisical.svc.cluster.local:8080",
    resyncInterval: 60,
    authentication: {
      // Kubernetes-native auth: no stored credential.
      kubernetesAuth: {
        identityId: "ca535f2a-a3f9-42f2-9ffe-3b369e496519",
        autoCreateServiceAccountToken: true,
        serviceAccountRef: { name: `${name}-infisical`, namespace: name },
        secretsScope: {
          projectSlug: "mem0-wzd-g",
          envSlug: "prod",
          secretsPath: "/",
        },
      },
    },
    managedSecretReference: {
      secretName: `${name}-secrets`,
      secretNamespace: name,
      // Orphan instead of Owner — tolerates the existing-Secret-on-first-
      // reconcile race and decouples Secret lifecycle from CR deletion.
      creationPolicy: "Orphan",
    },
  },
});

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

export const service = new Service({
  metadata: { name, labels },
  spec: {
    type: "ClusterIP",
    selector: labels,
    ports: [{ name: "http", port: apiPort, targetPort: "http" }],
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

export const dashboardService = new Service({
  metadata: { name: dashboardName, labels: dashboardLabels },
  spec: {
    type: "ClusterIP",
    selector: dashboardLabels,
    ports: [{ name: "http", port: dashboardPort, targetPort: "http" }],
  },
});

export const certificate = new Certificate({
  metadata: { name: `${name}-tls` },
  spec: {
    secretName: `${name}-tls`,
    issuerRef: { name: "letsencrypt-production", kind: "ClusterIssuer" },
    dnsNames: [apiHost],
  },
});

export const dashboardCertificate = new Certificate({
  metadata: { name: `${dashboardName}-tls` },
  spec: {
    secretName: `${dashboardName}-tls`,
    issuerRef: { name: "letsencrypt-production", kind: "ClusterIssuer" },
    dnsNames: [dashboardHost],
  },
});

// The redirect-https Middleware lives in the default namespace; these are
// spec-level cross-namespace references, not metadata.namespace.
const redirectToHttps = [{ name: "redirect-https", namespace: "default" }];

// Public mem0 API at https://mem0.inevitable.fyi. Auth is mem0's own JWT /
// X-API-Key — exposing on the open internet is safe because every protected
// route checks the Authorization header before doing anything, and AUTH_DISABLED
// is explicitly false on the Deployment.
export const ingressRoute = new IngressRoute({
  metadata: { name },
  spec: {
    entryPoints: ["websecure"],
    routes: [
      {
        match: `Host(\`${apiHost}\`)`,
        kind: "Rule",
        services: [{ name, port: apiPort }],
      },
    ],
    tls: { secretName: `${name}-tls` },
  },
});

export const ingressRouteHttp = new IngressRoute({
  metadata: { name: `${name}-http` },
  spec: {
    entryPoints: ["web"],
    routes: [
      {
        match: `Host(\`${apiHost}\`)`,
        kind: "Rule",
        middlewares: redirectToHttps,
        services: [{ name, port: apiPort }],
      },
    ],
  },
});

// Public dashboard at https://mem0-ui.inevitable.fyi. Same auth story — the
// dashboard issues login + register against the API and stores a JWT in browser
// storage. Unauthenticated traffic only sees the setup wizard / login screens.
export const dashboardIngressRoute = new IngressRoute({
  metadata: { name: dashboardName },
  spec: {
    entryPoints: ["websecure"],
    routes: [
      {
        match: `Host(\`${dashboardHost}\`)`,
        kind: "Rule",
        services: [{ name: dashboardName, port: dashboardPort }],
      },
    ],
    tls: { secretName: `${dashboardName}-tls` },
  },
});

export const dashboardIngressRouteHttp = new IngressRoute({
  metadata: { name: `${dashboardName}-http` },
  spec: {
    entryPoints: ["web"],
    routes: [
      {
        match: `Host(\`${dashboardHost}\`)`,
        kind: "Rule",
        middlewares: redirectToHttps,
        services: [{ name: dashboardName, port: dashboardPort }],
      },
    ],
  },
});
