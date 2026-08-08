import {
  ConfigMap,
  Container,
  Deployment,
  PersistentVolumeClaim,
  Probe,
} from "@intentius/chant-lexicon-k8s";
import { TraefikApp } from "@home-chant/traefik-app";

const name = "radicale";
const hostname = "dav.inevitable.fyi";

// Namespace, the Infisical identity pair, Service, Certificate and the
// IngressRoute redirect pair. The Deployment below is hand-written — see the
// composite's own comment for why the workload stays out of it.
//
// Keys in the radicale project:
//   HTPASSWD_USERS    — bcrypt htpasswd file content, mounted as
//                       /etc/radicale/users by the Deployment
//   RADICALE_PASSWORD — plaintext reference copy for configuring CalDAV clients
//                       (Apple Calendar, Cal.com); not consumed by any pod
const app = TraefikApp({
  name,
  host: hostname,
  port: 80,
  infisical: {
    identityId: "72e0768b-bcc4-4bc4-a495-48bcc7b4145d",
    projectSlug: "radicale-tx-mo",
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

// Calendar collections are plain .ics files under /data/collections — no
// database. Radicale is single-writer (filesystem locking), so the Deployment is
// single-replica with Recreate to avoid the RWO PVC handoff deadlock.
export const dataVolume = new PersistentVolumeClaim({
  metadata: { name: `${name}-data` },
  spec: {
    storageClassName: "longhorn",
    accessModes: ["ReadWriteOnce"],
    resources: { requests: { storage: "2Gi" } },
  },
});

const radicaleIni = `[server]
hosts = 0.0.0.0:5232

[auth]
type = htpasswd
htpasswd_filename = /etc/radicale/users
htpasswd_encryption = bcrypt
# bcrypt verification is deliberately slow (~100ms); CalDAV clients fire
# bursts of requests, so cache successful logins in-process instead of
# re-hashing on every PROPFIND.
cache_logins = true

[storage]
filesystem_folder = /data/collections

[logging]
level = info
`;

// Stable name rather than kustomize's content-hashed `radicale-config-<hash>`:
// rollout on change comes from the Reloader annotation on the Deployment, same
// arrangement ntfy uses. The key stays `config` so the mount lands at
// /config/config, which is where Radicale looks.
export const config = new ConfigMap({
  metadata: { name: `${name}-config` },
  data: { config: radicaleIni },
});

export const deployment = new Deployment({
  metadata: {
    name,
    labels,
    annotations: {
      // Radicale's cache_logins holds verified credentials in-process, so an
      // htpasswd rotation in Infisical needs a pod restart to reliably take
      // effect everywhere; the operator handles that via this annotation when
      // the radicale-auth Secret changes.
      "secrets.infisical.com/auto-reload": "true",
      // Stakater Reloader (installed cluster-wide by home-cloud, opt-in) does
      // the same for config changes.
      "configmap.reloader.stakater.com/reload": `${name}-config`,
    },
  },
  spec: {
    replicas: 1,
    // Filesystem storage on an RWO PVC — a rolling update would deadlock
    // waiting on the volume handoff.
    strategy: { type: "Recreate" },
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        securityContext: {
          // The tomsquest image supports running fully unprivileged; 2999 is its
          // baked-in radicale user. fsGroup makes the Longhorn volume writable
          // without the root-entrypoint chown path.
          runAsUser: 2999,
          runAsGroup: 2999,
          fsGroup: 2999,
          runAsNonRoot: true,
        },
        containers: [
          new Container({
            name,
            image: "tomsquest/docker-radicale:3.7.6.0",
            ports: [{ containerPort: 5232, name: "http" }],
            volumeMounts: [
              { name: "config", mountPath: "/config", readOnly: true },
              { name: "users", mountPath: "/etc/radicale", readOnly: true },
              { name: "data", mountPath: "/data" },
            ],
            resources: {
              requests: { cpu: "25m", memory: "64Mi" },
              limits: { memory: "256Mi" },
            },
            // GET / 303-redirects to the built-in web UI; kubelet treats any
            // 2xx/3xx as healthy, and the path needs no auth.
            readinessProbe: new Probe({
              httpGet: { path: "/", port: "http" },
              initialDelaySeconds: 5,
              periodSeconds: 10,
            }),
            livenessProbe: new Probe({
              httpGet: { path: "/", port: "http" },
              initialDelaySeconds: 15,
              periodSeconds: 30,
            }),
          }),
        ],
        volumes: [
          { name: "config", configMap: { name: `${name}-config` } },
          {
            name: "users",
            secret: {
              secretName: `${name}-auth`,
              // Only the htpasswd content is a file; RADICALE_PASSWORD stays out
              // of the pod entirely.
              items: [{ key: "HTPASSWD_USERS", path: "users" }],
            },
          },
          { name: "data", persistentVolumeClaim: { claimName: `${name}-data` } },
        ],
      },
    },
  },
});
