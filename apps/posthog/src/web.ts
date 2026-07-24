// Django + built frontend (gunicorn). Migrations run separately as a Job
// (see migrate.ts) rather than in this container's entrypoint, so `web` can
// scale past 1 replica later without racing concurrent `manage.py migrate`
// runs — its command is `bin/docker-server` directly, skipping hobby's
// `/compose/start` wrapper (wait + migrate + serve).
import { Deployment, Service, Container, Probe } from "@intentius/chant-lexicon-k8s";
import {
  POSTHOG_APP_IMAGE,
  HOSTNAME,
  postgresConnEnv,
  redisEnv,
  kafkaEnv,
  clickhouseEnv,
  objectStorageConnEnv,
  sessionRecordingS3Env,
  posthogSecretEnv,
  personhogEnv,
  featureFlagsServiceEnv,
  databaseUrl,
} from "./common.js";

const name = "web";
const labels = { "app.kubernetes.io/name": name };

const webEnv = postgresConnEnv.concat(
  [{ name: "DATABASE_URL", value: databaseUrl("posthog") }],
  redisEnv,
  kafkaEnv,
  clickhouseEnv,
  objectStorageConnEnv,
  sessionRecordingS3Env,
  posthogSecretEnv,
  personhogEnv,
  featureFlagsServiceEnv,
  [
    { name: "SITE_URL", value: `https://${HOSTNAME}` },
    { name: "IS_BEHIND_PROXY", value: "true" },
    { name: "DISABLE_SECURE_SSL_REDIRECT", value: "true" },
    { name: "DEPLOYMENT", value: "hobby" },
    { name: "OTEL_SDK_DISABLED", value: "true" },
    { name: "RECORDING_API_URL", value: "http://recording-api:6738" },
    { name: "POSTHOG_SKIP_MIGRATION_CHECKS", value: "1" },
  ],
);

export const webDeployment = new Deployment({
  metadata: {
    name,
    labels,
    annotations: { "secrets.infisical.com/auto-reload": "true" },
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: labels },
    template: {
      metadata: { labels, annotations: { "secrets.infisical.com/auto-reload": "true" } },
      spec: {
        containers: [
          new Container({
            name: "web",
            image: POSTHOG_APP_IMAGE,
            imagePullPolicy: "IfNotPresent",
            command: ["./bin/docker-server"],
            env: webEnv,
            ports: [{ containerPort: 8000, name: "http" }],
            resources: {
              requests: { cpu: "100m", memory: "512Mi" },
              limits: { memory: "1.5Gi" },
            },
            // `_health` is Django's confirmed-registered probe route (posthog/urls.py
            // notes livez/_readyz as the intended replacements but only _health is
            // actually wired to a URL pattern there, so that's what's used here).
            readinessProbe: new Probe({
              httpGet: { path: "/_health", port: 8000 },
              initialDelaySeconds: 20,
              periodSeconds: 10,
            }),
            livenessProbe: new Probe({
              httpGet: { path: "/_health", port: 8000 },
              initialDelaySeconds: 30,
              periodSeconds: 15,
            }),
          }),
        ],
      },
    },
  },
});

export const webService = new Service({
  metadata: { name, labels },
  spec: { selector: labels, ports: [{ port: 8000, targetPort: 8000, protocol: "TCP", name: "http" }] },
});
