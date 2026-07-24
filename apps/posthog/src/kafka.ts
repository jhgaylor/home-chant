// Kafka-API-compatible broker for the ingestion pipeline. The hobby stack's
// `kafka` service is actually Redpanda (single-node, self-seeded Raft — no
// Zookeeper involved, see zookeeper.ts). Service is named "kafka" because
// every consumer (ClickHouse, capture, plugins, ingestion-*) is configured
// with `KAFKA_HOSTS: kafka:9092`, matching the hobby compose's service name.
//
// `redpanda.auto_create_topics_enabled=true` means we don't need a separate
// topic-bootstrap Job — topics are created on first produce.
//
// Sized down from the compose defaults (`--smp 2 --memory 3G`) to fit this
// cluster's shared 44GiB envelope; `KAFKA_LOG_RETENTION_HOURS`-equivalent
// (1h, matching hobby's override) keeps the PVC small.
import { StatefulSet, Service, Container, Probe } from "@intentius/chant-lexicon-k8s";

const name = "kafka";
const labels = { "app.kubernetes.io/name": name };

export const kafkaStatefulSet = new StatefulSet({
  metadata: { name, labels },
  spec: {
    serviceName: name,
    replicas: 1,
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        containers: [
          new Container({
            name: "redpanda",
            image: "docker.io/redpandadata/redpanda:v25.1.9",
            imagePullPolicy: "IfNotPresent",
            command: [
              "redpanda",
              "start",
              "--kafka-addr",
              "internal://0.0.0.0:9092",
              "--advertise-kafka-addr",
              "internal://kafka:9092",
              "--rpc-addr",
              "kafka:33145",
              "--advertise-rpc-addr",
              "kafka:33145",
              "--mode",
              "dev-container",
              "--smp",
              "1",
              "--memory",
              "1200M",
              "--reserve-memory",
              "200M",
              "--overprovisioned",
              "--set",
              "redpanda.empty_seed_starts_cluster=false",
              "--seeds",
              "kafka:33145",
              "--set",
              "redpanda.auto_create_topics_enabled=true",
            ],
            env: [{ name: "ALLOW_PLAINTEXT_LISTENER", value: "true" }],
            ports: [
              { containerPort: 9092, name: "kafka" },
              { containerPort: 33145, name: "rpc" },
              { containerPort: 9644, name: "admin" },
            ],
            volumeMounts: [{ name: "data", mountPath: "/var/lib/redpanda/data" }],
            resources: {
              requests: { cpu: "250m", memory: "1500Mi" },
              limits: { cpu: "1", memory: "2Gi" },
            },
            readinessProbe: new Probe({
              httpGet: { path: "/v1/status/ready", port: 9644 },
              initialDelaySeconds: 5,
            }),
            livenessProbe: new Probe({
              httpGet: { path: "/v1/status/ready", port: 9644 },
              initialDelaySeconds: 15,
              periodSeconds: 15,
            }),
          }),
        ],
      },
    },
    volumeClaimTemplates: [
      {
        metadata: { name: "data" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          storageClassName: "longhorn",
          resources: { requests: { storage: "10Gi" } },
        },
      },
    ],
  },
});

export const kafkaService = new Service({
  metadata: { name, labels },
  spec: {
    clusterIP: "None",
    selector: labels,
    ports: [
      { port: 9092, targetPort: 9092, protocol: "TCP", name: "kafka" },
      { port: 33145, targetPort: 33145, protocol: "TCP", name: "rpc" },
      { port: 9644, targetPort: 9644, protocol: "TCP", name: "admin" },
    ],
  },
});
