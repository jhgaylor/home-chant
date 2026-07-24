// ClickHouse — the analytics event store. Config is carried over verbatim
// (byte-for-byte) from PostHog's own docker/clickhouse/ assets in
// posthog/posthog, checked into ./assets/clickhouse/ here, rather than
// hand-translated — see that directory's provenance in the home-chant
// README. `config.d/default.xml` and `config.xml`'s `<zookeeper>` block both
// hardcode the hostnames "clickhouse" and "zookeeper", so those two Service
// names are load-bearing and must not change.
//
// NOT ported: `user_defined_function.xml` and its `user_scripts/` binaries
// (`aggregate_funnel`, `json_drop_keys_udf`) — those are precompiled,
// architecture-specific executables checked into the posthog/posthog repo.
// Without them the Funnels insight type will error; everything else
// (events, session replay, feature flags, surveys) is unaffected. Documented
// as a known v1 gap in the app README.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StatefulSet, Service, ConfigMap, Container, Probe } from "@intentius/chant-lexicon-k8s";

const name = "clickhouse";
const labels = { "app.kubernetes.io/name": name };

const assetsDir = fileURLToPath(new URL("./assets/clickhouse/", import.meta.url));
const readAsset = (path: string) => readFileSync(`${assetsDir}${path}`, "utf-8");

// chant's EVL001 lint requires resource constructor properties to be
// statically evaluable, so the file reads are hoisted to consts here rather
// than called inline in the ConfigMap `data` object below.
const configXml = readAsset("config.xml");
const defaultXml = readAsset("default.xml");
const usersXml = readAsset("users.xml");
const idlEventsDeadLetterQueue = readAsset("idl/events_dead_letter_queue.json");
const idlEventsJson = readAsset("idl/events_json.json");
const idlGroups = readAsset("idl/groups.json");
const idlPerson = readAsset("idl/person.json");
const idlPersonDistinctId = readAsset("idl/person_distinct_id.json");
const idlPersonDistinctId2 = readAsset("idl/person_distinct_id2.json");
const idlPluginLogEntries = readAsset("idl/plugin_log_entries.json");
const initDbSh = readAsset("initdb/init-db.sh");

export const clickhouseConfigMap = new ConfigMap({
  metadata: { name: "clickhouse-config", labels },
  data: {
    "config.xml": configXml,
    "default.xml": defaultXml,
    "users.xml": usersXml,
  },
});

export const clickhouseIdlConfigMap = new ConfigMap({
  metadata: { name: "clickhouse-idl", labels },
  data: {
    "events_dead_letter_queue.json": idlEventsDeadLetterQueue,
    "events_json.json": idlEventsJson,
    "groups.json": idlGroups,
    "person.json": idlPerson,
    "person_distinct_id.json": idlPersonDistinctId,
    "person_distinct_id2.json": idlPersonDistinctId2,
    "plugin_log_entries.json": idlPluginLogEntries,
  },
});

export const clickhouseInitdbConfigMap = new ConfigMap({
  metadata: { name: "clickhouse-initdb", labels },
  data: {
    "init-db.sh": initDbSh,
  },
});

export const clickhouseStatefulSet = new StatefulSet({
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
            name: "clickhouse",
            image: "clickhouse/clickhouse-server:26.6.1.1193",
            imagePullPolicy: "IfNotPresent",
            env: [
              { name: "CLICKHOUSE_SKIP_USER_SETUP", value: "1" },
              { name: "KAFKA_HOSTS", value: "kafka:9092" },
            ],
            ports: [
              { containerPort: 8123, name: "http" },
              { containerPort: 9000, name: "native" },
              { containerPort: 9009, name: "interserver" },
            ],
            volumeMounts: [
              { name: "data", mountPath: "/var/lib/clickhouse" },
              { name: "config", mountPath: "/etc/clickhouse-server/config.xml", subPath: "config.xml" },
              {
                name: "config",
                mountPath: "/etc/clickhouse-server/config.d/default.xml",
                subPath: "default.xml",
              },
              { name: "config", mountPath: "/etc/clickhouse-server/users.xml", subPath: "users.xml" },
              { name: "idl", mountPath: "/idl" },
              { name: "initdb", mountPath: "/docker-entrypoint-initdb.d" },
            ],
            resources: {
              requests: { cpu: "250m", memory: "1Gi" },
              limits: { cpu: "1", memory: "2Gi" },
            },
            readinessProbe: new Probe({
              httpGet: { path: "/ping", port: 8123 },
              initialDelaySeconds: 10,
            }),
            livenessProbe: new Probe({
              httpGet: { path: "/ping", port: 8123 },
              initialDelaySeconds: 30,
              periodSeconds: 15,
            }),
          }),
        ],
        volumes: [
          { name: "config", configMap: { name: "clickhouse-config" } },
          { name: "idl", configMap: { name: "clickhouse-idl" } },
          { name: "initdb", configMap: { name: "clickhouse-initdb", defaultMode: 0o755 } },
        ],
      },
    },
    volumeClaimTemplates: [
      {
        metadata: { name: "data" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          storageClassName: "longhorn",
          resources: { requests: { storage: "20Gi" } },
        },
      },
    ],
  },
});

export const clickhouseService = new Service({
  metadata: { name, labels },
  spec: {
    clusterIP: "None",
    selector: labels,
    ports: [
      { port: 8123, targetPort: 8123, protocol: "TCP", name: "http" },
      { port: 9000, targetPort: 9000, protocol: "TCP", name: "native" },
      { port: 9009, targetPort: 9009, protocol: "TCP", name: "interserver" },
    ],
  },
});
