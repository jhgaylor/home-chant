// Node-based plugin-server processes. All four share the same image
// (`posthog-node`) and entrypoint (`node nodejs/dist/index.js`); which role
// each plays is selected entirely by `PLUGIN_SERVER_MODE`, matching hobby's
// four separate containers built from one image.
import { Deployment, Service, Container, Probe } from "@intentius/chant-lexicon-k8s";
import {
  POSTHOG_NODE_IMAGE,
  postgresConnEnv,
  redisEnv,
  kafkaEnv,
  clickhouseEnv,
  posthogSecretEnv,
  databaseUrl,
} from "./common.js";

const posthogDbUrlEnv = { name: "DATABASE_URL", value: databaseUrl("posthog") };
const personsDbUrlEnv = { name: "PERSONS_DATABASE_URL", value: databaseUrl("posthog") };
const behavioralCohortsDbUrlEnv = { name: "BEHAVIORAL_COHORTS_DATABASE_URL", value: databaseUrl("posthog") };

// `plugins` — webhooks + CDP/hog-function destinations.
const pluginsEnv = postgresConnEnv.concat(
  [posthogDbUrlEnv, personsDbUrlEnv, behavioralCohortsDbUrlEnv],
  kafkaEnv,
  redisEnv,
  clickhouseEnv,
);

// `ingestion-general` — main event-processing consumer (person/group
// resolution, property defs, cohorts).
const ingestionGeneralEnv = postgresConnEnv.concat(
  [posthogDbUrlEnv, personsDbUrlEnv, behavioralCohortsDbUrlEnv],
  kafkaEnv,
  redisEnv,
  clickhouseEnv,
  posthogSecretEnv,
  [
    { name: "PLUGIN_SERVER_MODE", value: "ingestion-v2-combined" },
    { name: "COOKIELESS_REDIS_HOST", value: "redis" },
    { name: "COOKIELESS_REDIS_PORT", value: "6379" },
    { name: "CDP_REDIS_HOST", value: "redis" },
  ],
);

// `ingestion-sessionreplay` — consumes replay Kafka topic, writes blobs to
// object storage (Garage, see objectstorage.ts).
const ingestionSessionReplayEnv = postgresConnEnv.concat(
  [posthogDbUrlEnv],
  kafkaEnv,
  redisEnv,
  posthogSecretEnv,
  [
    { name: "PLUGIN_SERVER_MODE", value: "recordings-blob-ingestion-v2" },
    {
      name: "SESSION_RECORDING_V2_S3_ACCESS_KEY_ID",
      valueFrom: { secretKeyRef: { name: "posthog-object-storage-credentials", key: "AWS_ACCESS_KEY_ID" } },
    },
    {
      name: "SESSION_RECORDING_V2_S3_SECRET_ACCESS_KEY",
      valueFrom: { secretKeyRef: { name: "posthog-object-storage-credentials", key: "AWS_SECRET_ACCESS_KEY" } },
    },
    { name: "SESSION_RECORDING_V2_S3_TIMEOUT_MS", value: "120000" },
    { name: "SESSION_RECORDING_V2_S3_ENDPOINT", value: "http://s3.garage.svc.cluster.local:3900" },
  ],
);

// `recording-api` — serves recording playback reads from ClickHouse + S3.
const recordingApiEnv = postgresConnEnv.concat(
  [posthogDbUrlEnv],
  redisEnv,
  clickhouseEnv,
  posthogSecretEnv,
  [
    { name: "PLUGIN_SERVER_MODE", value: "recording-api" },
    { name: "SESSION_RECORDING_API_REDIS_HOST", value: "redis" },
    { name: "SESSION_RECORDING_API_REDIS_PORT", value: "6379" },
  ],
);

function nodeService(name: string, env: Array<Record<string, unknown>>, port: number | null) {
  const labels = { "app.kubernetes.io/name": name };
  const container = new Container({
    name: "plugin-server",
    image: POSTHOG_NODE_IMAGE,
    imagePullPolicy: "IfNotPresent",
    command: ["node", "nodejs/dist/index.js"],
    env,
    ports: port ? [{ containerPort: port, name: "http" }] : undefined,
    resources: {
      requests: { cpu: "50m", memory: "256Mi" },
      limits: { memory: "768Mi" },
    },
    readinessProbe: port ? new Probe({ tcpSocket: { port }, initialDelaySeconds: 10 }) : undefined,
    livenessProbe: port ? new Probe({ tcpSocket: { port }, initialDelaySeconds: 30 }) : undefined,
  });

  const deployment = new Deployment({
    metadata: { name, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: { metadata: { labels }, spec: { containers: [container] } },
    },
  });

  if (!port) return { deployment, service: undefined };

  const service = new Service({
    metadata: { name, labels },
    spec: { selector: labels, ports: [{ port, targetPort: port, protocol: "TCP", name: "http" }] },
  });
  return { deployment, service };
}

const plugins = nodeService("plugins", pluginsEnv, 6738);
const ingestionGeneral = nodeService("ingestion-general", ingestionGeneralEnv, null);
const ingestionSessionReplay = nodeService("ingestion-sessionreplay", ingestionSessionReplayEnv, null);
const recordingApi = nodeService("recording-api", recordingApiEnv, 6738);

export const pluginsDeployment = plugins.deployment;
export const pluginsService = plugins.service;
export const ingestionGeneralDeployment = ingestionGeneral.deployment;
export const ingestionSessionReplayDeployment = ingestionSessionReplay.deployment;
export const recordingApiDeployment = recordingApi.deployment;
export const recordingApiService = recordingApi.service;
