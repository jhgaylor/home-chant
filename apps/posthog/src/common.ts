// Shared image refs and env-var building blocks reused across most of the
// PostHog services, to avoid re-deriving the same secretKeyRef wiring in
// every file. PostHog doesn't publish immutable version tags any more (their
// own deploy-hobby script: "PostHog don't create tagged releases anymore.
// It's way better to use 'latest' than 'latest-release'") — so every image
// below floats, matching what upstream itself recommends. This trips chant's
// WK8006 "no latest/floating tags" lint on every Deployment; that's expected
// and accepted here, not an oversight.
export const POSTHOG_APP_IMAGE = "posthog/posthog:latest";
export const POSTHOG_NODE_IMAGE = "posthog/posthog-node:latest";
export const POSTHOG_CAPTURE_IMAGE = "ghcr.io/posthog/posthog/capture:master";
export const POSTHOG_PROPERTY_DEFS_IMAGE = "ghcr.io/posthog/posthog/property-defs-rs:master";
export const POSTHOG_FEATURE_FLAGS_IMAGE = "ghcr.io/posthog/posthog/feature-flags:master";
export const POSTHOG_HYPERCACHE_IMAGE = "ghcr.io/posthog/posthog/hypercache-server:master";
export const POSTHOG_PERSONHOG_REPLICA_IMAGE = "ghcr.io/posthog/posthog/personhog-replica:master";
export const POSTHOG_PERSONHOG_ROUTER_IMAGE = "ghcr.io/posthog/posthog/personhog-router:master";

export const HOSTNAME = "highrise.inevitable.fyi";

// Built from CNPG's auto-generated `posthog-pg-app` Secret (see postgres.ts).
// `$(VAR)` is Kubernetes' own dependent-env-var expansion (resolved by the
// kubelet, not a build-time template) — it lets every consumer compose its
// own `postgres://user:pass@host:port/<database>` URL for whichever of the
// two databases (posthog / posthog_persons) it needs, from these three
// shared entries, without us handling credentials in TypeScript at all.
export const postgresConnEnv = [
  { name: "PGUSER", valueFrom: { secretKeyRef: { name: "posthog-pg-app", key: "username" } } },
  { name: "PGPASSWORD", valueFrom: { secretKeyRef: { name: "posthog-pg-app", key: "password" } } },
  { name: "PGHOST", valueFrom: { secretKeyRef: { name: "posthog-pg-app", key: "host" } } },
];

export const databaseUrl = (database: string) => `postgres://$(PGUSER):$(PGPASSWORD)@$(PGHOST):5432/${database}`;

export const redisEnv = [{ name: "REDIS_URL", value: "redis://redis:6379/" }];

export const kafkaEnv = [{ name: "KAFKA_HOSTS", value: "kafka:9092" }];

export const clickhouseEnv = [
  { name: "CLICKHOUSE_HOST", value: "clickhouse" },
  { name: "CLICKHOUSE_DATABASE", value: "posthog" },
  { name: "CLICKHOUSE_SECURE", value: "false" },
  { name: "CLICKHOUSE_VERIFY", value: "false" },
];

// Reused across web/worker/plugins/capture-ai-equivalents. Backed by Garage
// (see objectstorage.ts) instead of hobby's MinIO+SeaweedFS split — one
// endpoint covers both OBJECT_STORAGE_* and SESSION_RECORDING_V2_S3_* roles.
export const objectStorageConnEnv = [
  {
    name: "OBJECT_STORAGE_ACCESS_KEY_ID",
    valueFrom: { secretKeyRef: { name: "posthog-object-storage-credentials", key: "AWS_ACCESS_KEY_ID" } },
  },
  {
    name: "OBJECT_STORAGE_SECRET_ACCESS_KEY",
    valueFrom: { secretKeyRef: { name: "posthog-object-storage-credentials", key: "AWS_SECRET_ACCESS_KEY" } },
  },
  { name: "OBJECT_STORAGE_ENDPOINT", value: "http://s3.garage.svc.cluster.local:3900" },
  { name: "OBJECT_STORAGE_ENABLED", value: "true" },
  { name: "OBJECT_STORAGE_FORCE_PATH_STYLE", value: "true" },
  { name: "OBJECT_STORAGE_BUCKET", value: "posthog" },
];

export const sessionRecordingS3Env = [
  {
    name: "SESSION_RECORDING_V2_S3_ACCESS_KEY_ID",
    valueFrom: { secretKeyRef: { name: "posthog-object-storage-credentials", key: "AWS_ACCESS_KEY_ID" } },
  },
  {
    name: "SESSION_RECORDING_V2_S3_SECRET_ACCESS_KEY",
    valueFrom: { secretKeyRef: { name: "posthog-object-storage-credentials", key: "AWS_SECRET_ACCESS_KEY" } },
  },
  { name: "SESSION_RECORDING_V2_S3_ENDPOINT", value: "http://s3.garage.svc.cluster.local:3900" },
];

// Django SECRET_KEY / ENCRYPTION_SALT_KEYS from the InfisicalSecret in
// secrets.ts.
export const posthogSecretEnv = [
  { name: "SECRET_KEY", valueFrom: { secretKeyRef: { name: "posthog-secrets", key: "SECRET_KEY" } } },
  {
    name: "ENCRYPTION_SALT_KEYS",
    valueFrom: { secretKeyRef: { name: "posthog-secrets", key: "ENCRYPTION_SALT_KEYS" } },
  },
];

export const personhogEnv = [
  { name: "PERSONHOG_ADDR", value: "personhog-router:50052" },
  { name: "PERSONHOG_ENABLED", value: "true" },
];

export const featureFlagsServiceEnv = [
  { name: "FEATURE_FLAGS_SERVICE_URL", value: "http://feature-flags:3001" },
];
