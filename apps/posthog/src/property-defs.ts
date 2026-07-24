// Consumes the ingestion Kafka stream and writes property/event definitions
// to Postgres — powers the data-management UI's property/event autocomplete.
// Not on the hot ingestion path itself, so no exposed port/Service.
import { Deployment, Container } from "@intentius/chant-lexicon-k8s";
import { POSTHOG_PROPERTY_DEFS_IMAGE, postgresConnEnv, kafkaEnv, databaseUrl } from "./common.js";

const name = "property-defs-rs";
const labels = { "app.kubernetes.io/name": name };

const env = postgresConnEnv.concat(
  [{ name: "DATABASE_URL", value: databaseUrl("posthog") }],
  kafkaEnv,
  [
    { name: "SKIP_WRITES", value: "false" },
    { name: "SKIP_READS", value: "false" },
    { name: "FILTER_MODE", value: "opt-out" },
  ],
);

export const propertyDefsDeployment = new Deployment({
  metadata: { name, labels },
  spec: {
    replicas: 1,
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        containers: [
          new Container({
            name: "property-defs-rs",
            image: POSTHOG_PROPERTY_DEFS_IMAGE,
            imagePullPolicy: "IfNotPresent",
            env,
            resources: {
              requests: { cpu: "50m", memory: "128Mi" },
              limits: { memory: "384Mi" },
            },
          }),
        ],
      },
    },
  },
});
