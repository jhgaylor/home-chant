// Postgres backend for PostHog. A single CNPG cluster serves both databases
// the hobby stack expects: `posthog` (the main Django + plugin-server DB) and
// `posthog_persons` (personhog's dedicated DB, per its `PRIMARY_DATABASE_URL`
// in docker-compose.base.yml — hobby keeps persons in the same Postgres
// instance as everything else, just a separate database).
//
// CNPG auto-generates a Secret `posthog-pg-app` holding the `posthog` app
// user's credentials (`username`, `password`, `host`, `port`, `dbname`,
// `uri`, ...). Since `postInitSQL` grants that same user ownership of
// `posthog_persons` too, every service can build whichever database URL it
// needs from the one Secret's username/password/host — see web.ts's
// `postgresEnv` helper.
import { CnpgCluster } from "./crds.js";

export const postgresCluster = new CnpgCluster({
  metadata: { name: "posthog-pg", labels: { "app.kubernetes.io/name": "posthog-pg" } },
  spec: {
    instances: 1,

    imageName: "ghcr.io/cloudnative-pg/postgresql:17.6-standard-trixie",

    bootstrap: {
      initdb: {
        database: "posthog",
        owner: "posthog",
        postInitSQL: ["CREATE DATABASE posthog_persons OWNER posthog;"],
      },
    },

    storage: {
      storageClass: "longhorn",
      size: "20Gi",
    },

    resources: {
      requests: { cpu: "100m", memory: "512Mi" },
      limits: { memory: "1Gi" },
    },
  },
});
