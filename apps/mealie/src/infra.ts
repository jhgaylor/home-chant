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

const name = "mealie";
const hostname = "mealie.inevitable.fyi";
const port = 9000;
const labels = { app: name };

// Namespaced resources deliberately carry no `metadata.namespace` — the Flux
// Kustomization in home-cloud sets `targetNamespace: mealie` (chant's WK8001
// flags hardcoded namespaces in source). The Namespace object itself survives
// that transform unchanged, so this is still what creates the namespace.
export const namespace = new Namespace({ metadata: { name } });

// Identity the secrets-operator presents to Infisical for the InfisicalSecret
// below (kubernetesAuth). The `mealie-operator` machine identity on the server
// is restricted to exactly this ServiceAccount + namespace; the operator mints
// short-lived tokens for it.
export const serviceAccount = new ServiceAccount({
  metadata: { name: `${name}-infisical` },
});

// Materializes a Secret named `mealie-secrets` holding SMTP_PASSWORD (the Resend
// API key) — the only secret value here; the rest of the SMTP_* config is plain
// env on the Deployment. The namespaces below are spec fields, not
// `metadata.namespace`, so the Flux namespace transform does not rewrite them.
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
        identityId: "150b0c1f-edf2-49c2-9ceb-fba2f009a8b2",
        autoCreateServiceAccountToken: true,
        serviceAccountRef: { name: `${name}-infisical`, namespace: name },
        secretsScope: {
          projectSlug: "mealie-d-qiw",
          envSlug: "prod",
          secretsPath: "/",
        },
      },
    },
    managedSecretReference: {
      secretName: `${name}-secrets`,
      secretNamespace: name,
      // Orphan = operator overwrites existing Secret data in place; the
      // materialized Secret survives CR deletion.
      creationPolicy: "Orphan",
    },
  },
});

// Postgres backend (recipes, users, meal plans, shopping lists). Plain
// relational workload — no extensions needed, so the operator's default image
// variant is fine (unlike mem0, which pins "standard" for pgvector).
//
// CNPG auto-generates a `mealie-pg-app` Secret holding the application-user
// credentials (username, password, dbname, host, port, uri, ...); the Deployment
// reads those keys below to populate Mealie's POSTGRES_* vars.
//
// Single instance — Longhorn-level replication is enough for a household recipe
// box.
export const postgres = new Cluster({
  metadata: { name: `${name}-pg` },
  spec: {
    instances: 1,
    bootstrap: { initdb: { database: name, owner: name } },
    storage: { storageClass: "longhorn", size: "5Gi" },
    resources: {
      requests: { cpu: "50m", memory: "256Mi" },
      limits: { memory: "512Mi" },
    },
  },
});

// Mealie stores recipe images and data-exports on disk at /app/data even though
// Postgres holds the relational state. RWO + Recreate on the Deployment, same as
// every other single-writer PVC in the cluster.
export const dataVolume = new PersistentVolumeClaim({
  metadata: { name: `${name}-data` },
  spec: {
    accessModes: ["ReadWriteOnce"],
    storageClassName: "longhorn",
    resources: { requests: { storage: "5Gi" } },
  },
});

// Every POSTGRES_* value comes from the Secret CNPG generates for the cluster
// above, so nothing here has to know the credentials.
const pgSecret = `${name}-pg-app`;
const pgEnv = [
  { name: "POSTGRES_SERVER", valueFrom: { secretKeyRef: { name: pgSecret, key: "host" } } },
  { name: "POSTGRES_PORT", valueFrom: { secretKeyRef: { name: pgSecret, key: "port" } } },
  { name: "POSTGRES_USER", valueFrom: { secretKeyRef: { name: pgSecret, key: "username" } } },
  { name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: pgSecret, key: "password" } } },
  { name: "POSTGRES_DB", valueFrom: { secretKeyRef: { name: pgSecret, key: "dbname" } } },
];

export const deployment = new Deployment({
  metadata: {
    name,
    labels,
    annotations: {
      // Roll the pod when the Infisical operator rotates mealie-secrets —
      // Mealie reads env vars at startup, so a Secret update without a restart
      // is silently ignored.
      "secrets.infisical.com/auto-reload": "true",
    },
  },
  spec: {
    replicas: 1,
    // RWO data PVC is single-writer — a rolling update would deadlock waiting
    // for the old pod to release the volume.
    strategy: { type: "Recreate" },
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        containers: [
          new Container({
            name,
            // Official upstream image; release tags are immutable, so
            // IfNotPresent is safe — bump the tag to upgrade.
            image: "ghcr.io/mealie-recipes/mealie:v3.21.0",
            imagePullPolicy: "IfNotPresent",
            ports: [{ containerPort: port, name: "http" }],
            env: [
              { name: "TZ", value: "America/New_York" },
              // Used for share links, notifications, and (if enabled later) the
              // OIDC callback URL.
              { name: "BASE_URL", value: `https://${hostname}` },
              // Public ingress + open signup would be an invitation to
              // strangers' meal plans. Invite household members from the admin
              // UI instead (invite links still work).
              { name: "ALLOW_SIGNUP", value: "false" },
              { name: "DB_ENGINE", value: "postgres" },
              ...pgEnv,
              // Outbound mail via Resend (the cluster's mail provider) — powers
              // member invites and password resets. Only SMTP_PASSWORD (the
              // Resend API key) is secret; it arrives via envFrom below.
              { name: "SMTP_HOST", value: "smtp.resend.com" },
              { name: "SMTP_PORT", value: "465" },
              // Port 465 is implicit TLS = Mealie's "SSL" strategy (587 would
              // be "TLS"/STARTTLS).
              { name: "SMTP_AUTH_STRATEGY", value: "SSL" },
              { name: "SMTP_USER", value: "resend" },
              { name: "SMTP_FROM_EMAIL", value: "mealie@updates.inevitable.fyi" },
              { name: "SMTP_FROM_NAME", value: "Mealie" },
            ],
            envFrom: [{ secretRef: { name: `${name}-secrets` } }],
            volumeMounts: [{ name: "data", mountPath: "/app/data" }],
            resources: {
              requests: { cpu: "100m", memory: "512Mi" },
              limits: { memory: "1Gi" },
            },
            readinessProbe: new Probe({
              httpGet: { path: "/api/app/about", port: "http" },
              initialDelaySeconds: 15,
              periodSeconds: 10,
            }),
            livenessProbe: new Probe({
              httpGet: { path: "/api/app/about", port: "http" },
              initialDelaySeconds: 60,
              periodSeconds: 30,
            }),
          }),
        ],
        volumes: [
          { name: "data", persistentVolumeClaim: { claimName: `${name}-data` } },
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
    ports: [{ name: "http", port, targetPort: "http" }],
  },
});

export const certificate = new Certificate({
  metadata: { name: `${name}-tls` },
  spec: {
    secretName: `${name}-tls`,
    issuerRef: { name: "letsencrypt-production", kind: "ClusterIssuer" },
    dnsNames: [hostname],
  },
});

// Public Mealie at https://mealie.inevitable.fyi. Same exposure story as mem0:
// every route sits behind Mealie's own login and ALLOW_SIGNUP is false, so
// unauthenticated traffic only sees the login screen (plus any recipes
// deliberately shared via public link — which is the point of exposing it).
export const ingressRoute = new IngressRoute({
  metadata: { name },
  spec: {
    entryPoints: ["websecure"],
    routes: [
      {
        match: `Host(\`${hostname}\`)`,
        kind: "Rule",
        services: [{ name, port }],
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
        match: `Host(\`${hostname}\`)`,
        kind: "Rule",
        // The redirect-https Middleware lives in the default namespace; this is
        // a spec-level cross-namespace reference, not metadata.namespace.
        middlewares: [{ name: "redirect-https", namespace: "default" }],
        services: [{ name, port }],
      },
    ],
  },
});
