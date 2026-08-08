import {
  Certificate,
  Cluster,
  Container,
  Deployment,
  InfisicalSecret,
  IngressRoute,
  Namespace,
  Probe,
  Service,
  ServiceAccount,
} from "@intentius/chant-lexicon-k8s";

const name = "calcom";
const hostname = "cal.jakegaylor.com";
const port = 3000;
const labels = { app: name };

// Namespaced resources deliberately carry no `metadata.namespace` — the Flux
// Kustomization in home-cloud sets `targetNamespace: calcom` (chant's WK8001
// flags hardcoded namespaces in source). The Namespace object itself survives
// that transform unchanged, so this is still what creates the namespace.
export const namespace = new Namespace({ metadata: { name } });

// Identity the secrets-operator presents to Infisical for the InfisicalSecret
// below (kubernetesAuth). The `calcom-operator` machine identity on the server
// is restricted to exactly this ServiceAccount + namespace; the operator mints
// short-lived tokens for it.
export const serviceAccount = new ServiceAccount({
  metadata: { name: `${name}-infisical` },
});

// Materializes a Secret named `calcom-secrets` holding NEXTAUTH_SECRET,
// CALENDSO_ENCRYPTION_KEY and EMAIL_SERVER_PASSWORD (the Resend API key for
// booking emails), which the Deployment consumes via envFrom. The namespaces
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
        identityId: "187477dd-1cf2-4a4d-932e-80495fea4db0",
        autoCreateServiceAccountToken: true,
        serviceAccountRef: { name: `${name}-infisical`, namespace: name },
        secretsScope: {
          projectSlug: "calcom-8kfu",
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

// Public Cal.com at https://cal.jakegaylor.com — the scheduling backend for the
// ai.jakegaylor.com A2A agent's schedule-intro-call skill, and a human-usable
// booking page. Signup is not disabled at the ingress: Cal.com's first-run flow
// creates the admin account, after which new-user signup is closed from the
// admin settings.
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
