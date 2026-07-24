// Zookeeper — used exclusively by ClickHouse for Replicated-table-engine
// coordination (see clickhouse.ts's config.xml `<zookeeper>` block, which
// hardcodes host "zookeeper"). Redpanda does NOT use this — it runs its own
// Raft consensus internally (see kafka.ts).
import { StatefulSet, Service, Container, Probe } from "@intentius/chant-lexicon-k8s";

const name = "zookeeper";
const labels = { "app.kubernetes.io/name": name };

export const zookeeperStatefulSet = new StatefulSet({
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
            name: "zookeeper",
            image: "zookeeper:3.7.0",
            imagePullPolicy: "IfNotPresent",
            env: [
              { name: "ZOO_AUTOPURGE_PURGEINTERVAL", value: "1" },
              { name: "ZOO_AUTOPURGE_SNAPRETAINCOUNT", value: "3" },
            ],
            ports: [
              { containerPort: 2181, name: "client" },
              { containerPort: 2888, name: "peer" },
              { containerPort: 3888, name: "leader-election" },
            ],
            volumeMounts: [
              { name: "data", mountPath: "/data" },
              { name: "datalog", mountPath: "/datalog" },
              { name: "logs", mountPath: "/logs" },
            ],
            resources: {
              requests: { cpu: "25m", memory: "128Mi" },
              limits: { memory: "512Mi" },
            },
            readinessProbe: new Probe({ tcpSocket: { port: 2181 } }),
            livenessProbe: new Probe({ tcpSocket: { port: 2181 } }),
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
          resources: { requests: { storage: "2Gi" } },
        },
      },
      {
        metadata: { name: "datalog" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          storageClassName: "longhorn",
          resources: { requests: { storage: "2Gi" } },
        },
      },
      {
        metadata: { name: "logs" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          storageClassName: "longhorn",
          resources: { requests: { storage: "1Gi" } },
        },
      },
    ],
  },
});

export const zookeeperService = new Service({
  metadata: { name, labels },
  spec: {
    clusterIP: "None",
    selector: labels,
    ports: [
      { port: 2181, targetPort: 2181, protocol: "TCP", name: "client" },
      { port: 2888, targetPort: 2888, protocol: "TCP", name: "peer" },
      { port: 3888, targetPort: 3888, protocol: "TCP", name: "leader-election" },
    ],
  },
});
