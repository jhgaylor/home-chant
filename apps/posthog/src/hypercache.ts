// Serves /surveys and /array/* (remote-config) reads via Redis.
import { Deployment, Service, Container, Probe } from "@intentius/chant-lexicon-k8s";
import { POSTHOG_HYPERCACHE_IMAGE, redisEnv } from "./common.js";

const name = "hypercache-server";
const labels = { "app.kubernetes.io/name": name };

const env = redisEnv.concat([
  { name: "ADDRESS", value: "0.0.0.0:3002" },
  { name: "RUST_LOG", value: "info" },
]);

export const hypercacheDeployment = new Deployment({
  metadata: { name, labels },
  spec: {
    replicas: 1,
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        containers: [
          new Container({
            name: "hypercache-server",
            image: POSTHOG_HYPERCACHE_IMAGE,
            imagePullPolicy: "IfNotPresent",
            env,
            ports: [{ containerPort: 3002, name: "http" }],
            resources: {
              requests: { cpu: "25m", memory: "64Mi" },
              limits: { memory: "192Mi" },
            },
            readinessProbe: new Probe({
              httpGet: { path: "/_readiness", port: 3002 },
              initialDelaySeconds: 10,
            }),
            livenessProbe: new Probe({
              httpGet: { path: "/_readiness", port: 3002 },
              initialDelaySeconds: 20,
              periodSeconds: 15,
            }),
          }),
        ],
      },
    },
  },
});

export const hypercacheService = new Service({
  metadata: { name, labels },
  spec: { selector: labels, ports: [{ port: 3002, targetPort: 3002, protocol: "TCP", name: "http" }] },
});
