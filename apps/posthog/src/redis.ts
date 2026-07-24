// Redis — Celery broker, feature-flags/hypercache cache, cookieless-mode
// hashing, CDP/plugins queues. Matches hobby's `redis7` service. Treated as
// disposable cache/broker state (no PVC): a pod restart drops in-flight
// Celery tasks and cached flag evaluations, both of which rebuild themselves.
import { Deployment, Service, Container, Probe } from "@intentius/chant-lexicon-k8s";

const name = "redis";
const labels = { "app.kubernetes.io/name": name };

export const redisDeployment = new Deployment({
  metadata: { name, labels },
  spec: {
    replicas: 1,
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        containers: [
          new Container({
            name: "redis",
            image: "redis:7.2-alpine",
            imagePullPolicy: "IfNotPresent",
            command: ["redis-server", "--maxmemory-policy", "allkeys-lru", "--maxmemory", "200mb"],
            ports: [{ containerPort: 6379, name: "redis" }],
            resources: {
              requests: { cpu: "25m", memory: "64Mi" },
              limits: { memory: "256Mi" },
            },
            livenessProbe: new Probe({ exec: { command: ["redis-cli", "ping"] } }),
            readinessProbe: new Probe({ exec: { command: ["redis-cli", "ping"] } }),
          }),
        ],
      },
    },
  },
});

export const redisService = new Service({
  metadata: { name, labels },
  spec: {
    selector: labels,
    ports: [{ port: 6379, targetPort: 6379, protocol: "TCP", name: "redis" }],
  },
});
