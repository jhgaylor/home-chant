import {
  ConfigMap,
  Container,
  Deployment,
  PersistentVolumeClaim,
  Probe,
} from "@intentius/chant-lexicon-k8s";
import { TraefikApp } from "@home-chant/traefik-app";
import { params } from "@intentius/chant/params";

const name = "ntfy";
const hostname = `${name}.${params.domain}`;

// Namespace, the Infisical identity pair, Service, Certificate and the
// IngressRoute redirect pair. The Deployment below is hand-written — see the
// composite's own comment for why the workload stays out of it.
//
// The materialized `ntfy-auth` Secret holds NTFY_AUTH_USERS / TOKENS / ACCESS,
// which the Deployment reads via envFrom.
const app = TraefikApp({
  name,
  host: hostname,
  port: 80,
  issuer: params.issuer as string,
  infisical: {
    identityId: "30e98c30-2e34-426c-ad22-2e3e5d734e88",
    projectSlug: "ntfy-h-f-bm",
    secretName: `${name}-auth`,
  },
});

export const {
  namespace,
  serviceAccount,
  secret,
  service,
  certificate,
  ingressRoute,
  ingressRouteHttp,
} = app;

const labels = app.labels;

// SQLite-backed cache + user/auth DB + attachments live on one PVC. ntfy is
// single-writer, so the Deployment is single-replica with the Recreate strategy
// to avoid the RWO PVC handoff deadlock.
export const dataVolume = new PersistentVolumeClaim({
  metadata: { name: `${name}-data` },
  spec: {
    storageClassName: "longhorn",
    accessModes: ["ReadWriteOnce"],
    resources: { requests: { storage: "5Gi" } },
  },
});

const serverYml = `# Editing this file rolls the pod automatically: it lands in the
# ntfy-server-config ConfigMap, and the Deployment carries
# configmap.reloader.stakater.com/reload so Stakater Reloader restarts
# ntfy when the contents change. ntfy reads this once at startup.
#
# ntfy is reachable in two ways:
#   - Internally: http://ntfy.ntfy.svc.cluster.local  (Alertmanager → ntfy)
#   - Publicly:   https://ntfy.inevitable.fyi          (phone app subscribes here)
# base-url is the public origin; ntfy uses it when constructing
# attachment/link URLs and when verifying the Origin header.
base-url: "https://ntfy.inevitable.fyi"
listen-http: ":80"

# Trust X-Forwarded-* headers from Traefik — otherwise every client
# appears as the in-cluster pod IP for rate-limiting and ACLs.
behind-proxy: true

# Persisted state (PVC at /var/lib/ntfy).
cache-file: "/var/lib/ntfy/cache.db"
cache-duration: "12h"
auth-file: "/var/lib/ntfy/user.db"
attachment-cache-dir: "/var/lib/ntfy/attachments"

# Lock everything down. No unauthenticated reads or writes — required
# because the server is on the public internet. Topic ACLs are
# granted per-user/per-token via \`ntfy access\` after bootstrap.
auth-default-access: "deny-all"

# No browser UI — the phone app + curl + Alertmanager all hit the
# API (/v1/*, /{topic}/json, PUT /{topic}) with a bearer token,
# and serving the SPA on a public host just leaks what this is.
web-root: "disable"

# iOS APNs proxy: Apple kills background long-polling, so the
# official ntfy iOS app only delivers push notifications via APNs.
# Self-hosted ntfy can't speak APNs directly, so we send a tiny
# wake-up ping (topic name only) to ntfy.sh, which forwards via
# APNs to the iOS app. The app then pulls the actual message from
# this server using its stored bearer token — content never leaves
# our infra. Android delivery is direct and unaffected.
upstream-base-url: "https://ntfy.sh"
`;

// Stable name rather than kustomize's content-hashed `ntfy-server-config-<hash>`:
// rollout on change is handled by the Reloader annotation on the Deployment,
// which is what lets this file be TypeScript instead of a kustomize generator.
export const serverConfig = new ConfigMap({
  metadata: { name: `${name}-server-config` },
  data: { "server.yml": serverYml },
});

export const deployment = new Deployment({
  metadata: {
    name,
    labels,
    annotations: {
      // The Infisical operator restarts this Deployment when the ntfy-auth
      // Secret's values change, so rotated NTFY_AUTH_USERS / NTFY_AUTH_TOKENS
      // take effect — ntfy reads them once at startup, not per-request.
      "secrets.infisical.com/auto-reload": "true",
      // Stakater Reloader (installed cluster-wide by home-cloud, opt-in) does
      // the same for server.yml changes.
      "configmap.reloader.stakater.com/reload": `${name}-server-config`,
    },
  },
  spec: {
    replicas: 1,
    // SQLite is single-writer and the PVC is RWO. A rolling update would
    // deadlock waiting for the old pod to release the volume.
    strategy: { type: "Recreate" },
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        containers: [
          new Container({
            name,
            image: "binwiederhier/ntfy:v2.22.0",
            args: ["serve"],
            ports: [{ containerPort: 80, name: "http" }],
            // NTFY_AUTH_USERS / TOKENS / ACCESS, provisioned declaratively from
            // Infisical. ntfy reconciles its users table to match on every
            // startup, so editing the Infisical project is the rotation path.
            envFrom: [{ secretRef: { name: `${name}-auth` } }],
            volumeMounts: [
              { name: "config", mountPath: "/etc/ntfy", readOnly: true },
              { name: "data", mountPath: "/var/lib/ntfy" },
            ],
            resources: {
              requests: { cpu: "25m", memory: "64Mi" },
              limits: { memory: "256Mi" },
            },
            readinessProbe: new Probe({
              httpGet: { path: "/v1/health", port: "http" },
              initialDelaySeconds: 5,
              periodSeconds: 10,
            }),
            livenessProbe: new Probe({
              httpGet: { path: "/v1/health", port: "http" },
              initialDelaySeconds: 15,
              periodSeconds: 30,
            }),
          }),
        ],
        volumes: [
          { name: "config", configMap: { name: `${name}-server-config` } },
          { name: "data", persistentVolumeClaim: { claimName: `${name}-data` } },
        ],
      },
    },
  },
});
