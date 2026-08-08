import {
  Cluster,
  Container,
  Deployment,
  PersistentVolumeClaim,
  Probe,
} from "@intentius/chant-lexicon-k8s";
import { TraefikApp } from "@home-chant/traefik-app";

const name = "mealie";
const hostname = "mealie.inevitable.fyi";
const port = 9000;

// Namespace, the Infisical identity pair, Service, Certificate and the
// IngressRoute redirect pair. The Deployment below is hand-written — see the
// composite's own comment for why the workload stays out of it.
//
// `mealie-secrets` holds SMTP_PASSWORD (the Resend API key), the only secret
// value here; the rest of the SMTP_* config is plain env on the Deployment.
const app = TraefikApp({
  name,
  host: hostname,
  port,
  infisical: {
    identityId: "150b0c1f-edf2-49c2-9ceb-fba2f009a8b2",
    projectSlug: "mealie-d-qiw",
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
