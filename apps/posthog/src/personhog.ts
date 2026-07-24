// Person-processing service (replaced in-Django person merge/property
// logic). Despite the name, this is core-required — web.ts/worker.ts set
// PERSONHOG_ENABLED=true and point at personhog-router unconditionally.
// `-replica` owns the persons DB; `-router` is the gRPC front door other
// services talk to.
import { Deployment, Service, Container, Probe } from "@intentius/chant-lexicon-k8s";
import { POSTHOG_PERSONHOG_REPLICA_IMAGE, POSTHOG_PERSONHOG_ROUTER_IMAGE, postgresConnEnv, databaseUrl } from "./common.js";

const replicaName = "personhog-replica";
const replicaLabels = { "app.kubernetes.io/name": replicaName };

const replicaEnv = postgresConnEnv.concat([
  { name: "GRPC_ADDRESS", value: "0.0.0.0:50051" },
  { name: "PRIMARY_DATABASE_URL", value: databaseUrl("posthog_persons") },
  { name: "RUST_LOG", value: "info" },
  { name: "METRICS_PORT", value: "9100" },
]);

export const personhogReplicaDeployment = new Deployment({
  metadata: { name: replicaName, labels: replicaLabels },
  spec: {
    replicas: 1,
    selector: { matchLabels: replicaLabels },
    template: {
      metadata: { labels: replicaLabels },
      spec: {
        containers: [
          new Container({
            name: "personhog-replica",
            image: POSTHOG_PERSONHOG_REPLICA_IMAGE,
            imagePullPolicy: "IfNotPresent",
            env: replicaEnv,
            ports: [
              { containerPort: 50051, name: "grpc" },
              { containerPort: 9100, name: "metrics" },
            ],
            resources: {
              requests: { cpu: "25m", memory: "128Mi" },
              limits: { memory: "384Mi" },
            },
            readinessProbe: new Probe({ tcpSocket: { port: 50051 }, initialDelaySeconds: 10 }),
            livenessProbe: new Probe({ tcpSocket: { port: 50051 }, initialDelaySeconds: 20 }),
          }),
        ],
      },
    },
  },
});

export const personhogReplicaService = new Service({
  metadata: { name: replicaName, labels: replicaLabels },
  spec: {
    selector: replicaLabels,
    ports: [
      { port: 50051, targetPort: 50051, protocol: "TCP", name: "grpc" },
      { port: 9100, targetPort: 9100, protocol: "TCP", name: "metrics" },
    ],
  },
});

const routerName = "personhog-router";
const routerLabels = { "app.kubernetes.io/name": routerName };

const routerEnv = [
  { name: "GRPC_ADDRESS", value: "0.0.0.0:50052" },
  { name: "REPLICA_URL", value: "http://personhog-replica:50051" },
  { name: "BACKEND_TIMEOUT_MS", value: "5000" },
  { name: "RUST_LOG", value: "info" },
  { name: "METRICS_PORT", value: "9101" },
];

export const personhogRouterDeployment = new Deployment({
  metadata: { name: routerName, labels: routerLabels },
  spec: {
    replicas: 1,
    selector: { matchLabels: routerLabels },
    template: {
      metadata: { labels: routerLabels },
      spec: {
        containers: [
          new Container({
            name: "personhog-router",
            image: POSTHOG_PERSONHOG_ROUTER_IMAGE,
            imagePullPolicy: "IfNotPresent",
            env: routerEnv,
            ports: [
              { containerPort: 50052, name: "grpc" },
              { containerPort: 9101, name: "metrics" },
            ],
            resources: {
              requests: { cpu: "25m", memory: "64Mi" },
              limits: { memory: "192Mi" },
            },
            readinessProbe: new Probe({ tcpSocket: { port: 50052 }, initialDelaySeconds: 10 }),
            livenessProbe: new Probe({ tcpSocket: { port: 50052 }, initialDelaySeconds: 20 }),
          }),
        ],
      },
    },
  },
});

export const personhogRouterService = new Service({
  metadata: { name: routerName, labels: routerLabels },
  spec: {
    selector: routerLabels,
    ports: [
      { port: 50052, targetPort: 50052, protocol: "TCP", name: "grpc" },
      { port: 9101, targetPort: 9101, protocol: "TCP", name: "metrics" },
    ],
  },
});
