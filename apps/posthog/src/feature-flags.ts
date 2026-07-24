// Rust feature-flags evaluation service. Django's FEATURE_FLAGS_SERVICE_URL
// (see web.ts/worker.ts) points here — this replaced in-Django flag
// evaluation, so despite living outside the Django monolith it's
// core-required, not an add-on.
//
// MAXMIND_DB_PATH is intentionally unset: hobby mounts a GeoLite2 database
// that requires a MaxMind license key to download, which we haven't wired
// up (documented as a known v1 gap in the app README). Without it,
// IP-geolocation-based flag targeting degrades rather than failing outright.
import { Deployment, Service, Container, Probe } from "@intentius/chant-lexicon-k8s";
import { POSTHOG_FEATURE_FLAGS_IMAGE, postgresConnEnv, redisEnv, databaseUrl } from "./common.js";

const name = "feature-flags";
const labels = { "app.kubernetes.io/name": name };

const posthogDbUrl = databaseUrl("posthog");

const env = postgresConnEnv.concat(
  [
    { name: "WRITE_DATABASE_URL", value: posthogDbUrl },
    { name: "READ_DATABASE_URL", value: posthogDbUrl },
    { name: "PERSONS_WRITE_DATABASE_URL", value: posthogDbUrl },
    { name: "PERSONS_READ_DATABASE_URL", value: posthogDbUrl },
  ],
  redisEnv,
  [
    { name: "ADDRESS", value: "0.0.0.0:3001" },
    { name: "RUST_LOG", value: "info" },
    { name: "COOKIELESS_REDIS_HOST", value: "redis" },
    { name: "COOKIELESS_REDIS_PORT", value: "6379" },
  ],
);

export const featureFlagsDeployment = new Deployment({
  metadata: { name, labels },
  spec: {
    replicas: 1,
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        containers: [
          new Container({
            name: "feature-flags",
            image: POSTHOG_FEATURE_FLAGS_IMAGE,
            imagePullPolicy: "IfNotPresent",
            env,
            ports: [{ containerPort: 3001, name: "http" }],
            resources: {
              requests: { cpu: "50m", memory: "128Mi" },
              limits: { memory: "384Mi" },
            },
            readinessProbe: new Probe({
              httpGet: { path: "/_readiness", port: 3001 },
              initialDelaySeconds: 10,
            }),
            livenessProbe: new Probe({
              httpGet: { path: "/_readiness", port: 3001 },
              initialDelaySeconds: 20,
              periodSeconds: 15,
            }),
          }),
        ],
      },
    },
  },
});

export const featureFlagsService = new Service({
  metadata: { name, labels },
  spec: { selector: labels, ports: [{ port: 3001, targetPort: 3001, protocol: "TCP", name: "http" }] },
});
