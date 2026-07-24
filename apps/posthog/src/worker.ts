// Celery worker + scheduler (exports, email, other async Django tasks).
import { Deployment, Container } from "@intentius/chant-lexicon-k8s";
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

const name = "worker";
const labels = { "app.kubernetes.io/name": name };

const workerEnv = postgresConnEnv.concat(
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
    { name: "DEPLOYMENT", value: "hobby" },
    { name: "OTEL_SDK_DISABLED", value: "true" },
    { name: "CDP_API_URL", value: "http://plugins:6738" },
    { name: "FLAGS_REDIS_ENABLED", value: "false" },
    { name: "RECORDING_API_URL", value: "http://recording-api:6738" },
    { name: "POSTHOG_SKIP_MIGRATION_CHECKS", value: "1" },
    { name: "PERSONS_DB_WRITER_URL", value: databaseUrl("posthog") },
    { name: "PERSONS_DB_READER_URL", value: databaseUrl("posthog") },
  ],
);

export const workerDeployment = new Deployment({
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
            name: "worker",
            image: POSTHOG_APP_IMAGE,
            imagePullPolicy: "IfNotPresent",
            command: ["./bin/docker-worker-celery", "--with-scheduler"],
            env: workerEnv,
            resources: {
              requests: { cpu: "100m", memory: "512Mi" },
              limits: { memory: "1.5Gi" },
            },
          }),
        ],
      },
    },
  },
});
