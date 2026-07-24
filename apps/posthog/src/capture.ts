// Rust ingestion front doors. `capture` takes normal event/batch traffic;
// `replay-capture` takes session-replay snapshots. Same image, different
// CAPTURE_MODE/KAFKA_TOPIC — mirrors hobby's two containers built from the
// same `rust/` image with BIN=capture.
import { Deployment, Service, Container, Probe } from "@intentius/chant-lexicon-k8s";
import { POSTHOG_CAPTURE_IMAGE, kafkaEnv, redisEnv } from "./common.js";

const captureEnv = kafkaEnv.concat(redisEnv, [
  { name: "ADDRESS", value: "0.0.0.0:3000" },
  { name: "KAFKA_TOPIC", value: "events_plugin_ingestion" },
  { name: "CAPTURE_MODE", value: "events" },
  { name: "RUST_LOG", value: "info,rdkafka=warn" },
  { name: "CAPTURE_V1_SINKS", value: "msk" },
  { name: "CAPTURE_V1_SINK_MSK_KAFKA_HOSTS", value: "kafka:9092" },
  { name: "CAPTURE_V1_SINK_MSK_KAFKA_TOPIC_MAIN", value: "events_plugin_ingestion" },
  { name: "CAPTURE_V1_SINK_MSK_KAFKA_TOPIC_HISTORICAL", value: "events_plugin_ingestion_historical" },
  { name: "CAPTURE_V1_SINK_MSK_KAFKA_TOPIC_OVERFLOW", value: "events_plugin_ingestion_overflow" },
  { name: "CAPTURE_V1_SINK_MSK_KAFKA_TOPIC_DLQ", value: "events_plugin_ingestion_dlq" },
  { name: "CAPTURE_V1_SINK_MSK_KAFKA_TOPIC_EXCEPTION", value: "ingestion-errortracking-main" },
  { name: "CAPTURE_V1_SINK_MSK_KAFKA_TOPIC_HEATMAP", value: "heatmaps_ingestion" },
  {
    name: "CAPTURE_V1_SINK_MSK_KAFKA_TOPIC_CLIENT_INGESTION_WARNING",
    value: "ingestion-clientwarnings-main-1",
  },
]);

const replayCaptureEnv = kafkaEnv.concat(redisEnv, [
  { name: "ADDRESS", value: "0.0.0.0:3000" },
  { name: "KAFKA_TOPIC", value: "session_recording_snapshot_item_events" },
  { name: "CAPTURE_MODE", value: "recordings" },
]);

function captureDeployment(name: string, env: Array<Record<string, unknown>>) {
  const labels = { "app.kubernetes.io/name": name };
  return new Deployment({
    metadata: { name, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          containers: [
            new Container({
              name: "capture",
              image: POSTHOG_CAPTURE_IMAGE,
              imagePullPolicy: "IfNotPresent",
              env,
              ports: [{ containerPort: 3000, name: "http" }],
              resources: {
                requests: { cpu: "50m", memory: "128Mi" },
                limits: { memory: "384Mi" },
              },
              readinessProbe: new Probe({ tcpSocket: { port: 3000 }, initialDelaySeconds: 5 }),
              livenessProbe: new Probe({ tcpSocket: { port: 3000 }, initialDelaySeconds: 15 }),
            }),
          ],
        },
      },
    },
  });
}

function captureService(name: string) {
  const labels = { "app.kubernetes.io/name": name };
  return new Service({
    metadata: { name, labels },
    spec: { selector: labels, ports: [{ port: 3000, targetPort: 3000, protocol: "TCP", name: "http" }] },
  });
}

export const captureDeploymentResource = captureDeployment("capture", captureEnv);
export const captureServiceResource = captureService("capture");
export const replayCaptureDeploymentResource = captureDeployment("replay-capture", replayCaptureEnv);
export const replayCaptureServiceResource = captureService("replay-capture");
