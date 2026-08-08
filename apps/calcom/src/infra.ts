import { Cluster, Container, Deployment, Probe } from "@intentius/chant-lexicon-k8s";
import { TraefikApp } from "@home-chant/traefik-app";
import { params } from "@intentius/chant/params";

const name = "calcom";
const hostname = `cal.${params.domain}`;
const port = 3000;

// Namespace, the Infisical identity pair, Service, Certificate and the
// IngressRoute redirect pair. The Deployment below is hand-written — see the
// composite's own comment for why the workload stays out of it.
//
// The materialized `calcom-secrets` Secret holds NEXTAUTH_SECRET,
// CALENDSO_ENCRYPTION_KEY and EMAIL_SERVER_PASSWORD (the Resend API key for
// booking emails), which the Deployment consumes via envFrom.
const app = TraefikApp({
  name,
  host: hostname,
  port,
  issuer: params.issuer as string,
  infisical: {
    identityId: "187477dd-1cf2-4a4d-932e-80495fea4db0",
    projectSlug: "calcom-8kfu",
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

// Postgres backend (users, event types, bookings, availability schedules). Plain
// relational workload — the operator's default image variant is fine. Cal.com's
// entrypoint runs `prisma migrate deploy` at startup, so the schema manages
// itself.
//
// CNPG auto-generates a `calcom-pg-app` Secret holding the application-user
// credentials (username, password, dbname, host, port, uri, ...); the Deployment
// feeds `uri` straight into DATABASE_URL.
//
// Single instance — Longhorn-level replication is enough for a personal
// scheduling box.
export const postgres = new Cluster({
  metadata: { name: `${name}-pg` },
  spec: {
    instances: 1,
    bootstrap: {
      initdb: {
        // Cal.com's conventional database name.
        database: "calendso",
        owner: name,
      },
    },
    storage: { storageClass: "longhorn", size: "5Gi" },
    resources: {
      requests: { cpu: "50m", memory: "256Mi" },
      limits: { memory: "512Mi" },
    },
  },
});

const databaseUri = {
  valueFrom: { secretKeyRef: { name: `${name}-pg-app`, key: "uri" } },
};

export const deployment = new Deployment({
  metadata: {
    name,
    labels,
    annotations: {
      // Roll the pod when the Infisical operator rotates calcom-secrets —
      // Cal.com reads env vars at startup.
      "secrets.infisical.com/auto-reload": "true",
    },
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        containers: [
          new Container({
            name,
            // Upstream publishes arm64 builds under the `-arm` tag suffix (the
            // bare/latest tags are amd64-only, which fails to pull on this
            // all-arm64 cluster). Release tags are immutable — bump to upgrade.
            image: "docker.io/calcom/cal.com:v6.1.5-arm",
            imagePullPolicy: "IfNotPresent",
            ports: [{ containerPort: port, name: "http" }],
            env: [
              // The image bakes NEXT_PUBLIC_* at build time with a placeholder;
              // its entrypoint rewrites the bundle to this URL at startup.
              { name: "NEXT_PUBLIC_WEBAPP_URL", value: `https://${hostname}` },
              { name: "NEXTAUTH_URL", value: `https://${hostname}` },
              { name: "CALCOM_TELEMETRY_DISABLED", value: "1" },
              { name: "NEXT_PUBLIC_LICENSE_CONSENT", value: "agree" },
              { name: "DATABASE_URL", ...databaseUri },
              { name: "DATABASE_DIRECT_URL", ...databaseUri },
              // Booking notification emails via Resend (the cluster's mail
              // provider). Only EMAIL_SERVER_PASSWORD (the Resend API key) is
              // secret; it arrives via envFrom below.
              { name: "EMAIL_FROM", value: "cal@updates.inevitable.fyi" },
              { name: "EMAIL_FROM_NAME", value: "Jake Gaylor" },
              { name: "EMAIL_SERVER_HOST", value: "smtp.resend.com" },
              { name: "EMAIL_SERVER_PORT", value: "465" },
              { name: "EMAIL_SERVER_USER", value: "resend" },
            ],
            envFrom: [{ secretRef: { name: `${name}-secrets` } }],
            resources: {
              requests: { cpu: "250m", memory: "768Mi" },
              limits: { memory: "2Gi" },
            },
            // First boot runs prisma migrations + rewrites the NEXT_PUBLIC
            // placeholder across the bundle — give it a generous runway before
            // liveness kicks in.
            startupProbe: new Probe({
              httpGet: { path: "/auth/login", port: "http" },
              periodSeconds: 10,
              failureThreshold: 45,
            }),
            readinessProbe: new Probe({
              httpGet: { path: "/auth/login", port: "http" },
              periodSeconds: 15,
            }),
            livenessProbe: new Probe({
              tcpSocket: { port: "http" },
              periodSeconds: 30,
            }),
          }),
        ],
      },
    },
  },
});
