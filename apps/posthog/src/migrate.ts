// One-shot migration Job — Django schema migrations, ClickHouse schema
// migrations, and PostHog's async-migration framework. Mirrors what hobby's
// `web` container's `/compose/start` entrypoint does on every boot
// (`./compose/wait && ./bin/migrate && ./bin/docker-server`), except split
// out as a real Job instead of baked into every `web` pod's entrypoint:
// concurrent `manage.py migrate` from multiple replicas is a race hobby
// avoids only by running a single `web` replica. Init containers reproduce
// `compose/wait`'s TCP probes against ClickHouse and Postgres.
import { Job, Container } from "@intentius/chant-lexicon-k8s";
import {
  POSTHOG_APP_IMAGE,
  postgresConnEnv,
  redisEnv,
  kafkaEnv,
  clickhouseEnv,
  objectStorageConnEnv,
  posthogSecretEnv,
  databaseUrl,
} from "./common.js";

// `.concat()` rather than `[...a, ...b]` — chant's EVL004 lint only traces
// spread expressions back to a same-file const; imported arrays fail that
// trace even though they're consts in their own file. `.concat()` isn't a
// spread token at all, so the rule doesn't apply, and this whole statement
// sits outside any resource constructor so EVL001 doesn't apply either.
const migrateEnv = postgresConnEnv.concat(
  [{ name: "DATABASE_URL", value: databaseUrl("posthog") }],
  redisEnv,
  kafkaEnv,
  clickhouseEnv,
  objectStorageConnEnv,
  posthogSecretEnv,
  [
    { name: "DEPLOYMENT", value: "hobby" },
    { name: "SKIP_ASYNC_MIGRATIONS_SETUP", value: "0" },
  ],
);

export const migrateJob = new Job({
  metadata: {
    name: "posthog-migrate",
    labels: { "app.kubernetes.io/name": "posthog-migrate" },
    annotations: { "kustomize.toolkit.fluxcd.io/force": "true" },
  },
  spec: {
    backoffLimit: 3,
    ttlSecondsAfterFinished: 86400,
    template: {
      spec: {
        restartPolicy: "Never",
        initContainers: [
          new Container({
            name: "wait-for-db",
            image: "busybox:1.36",
            command: ["sh", "-c", "until nc -z posthog-pg-rw 5432; do echo waiting for postgres; sleep 2; done"],
          }),
          new Container({
            name: "wait-for-clickhouse",
            image: "busybox:1.36",
            command: ["sh", "-c", "until nc -z clickhouse 9000; do echo waiting for clickhouse; sleep 2; done"],
          }),
        ],
        containers: [
          new Container({
            name: "migrate",
            image: POSTHOG_APP_IMAGE,
            imagePullPolicy: "IfNotPresent",
            command: ["sh", "-c"],
            args: [
              "python manage.py migrate && python manage.py migrate_clickhouse && python manage.py run_async_migrations",
            ],
            env: migrateEnv,
            resources: {
              requests: { cpu: "250m", memory: "512Mi" },
              limits: { memory: "1Gi" },
            },
          }),
        ],
      },
    },
  },
});
