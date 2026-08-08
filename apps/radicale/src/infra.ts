import {
  Certificate,
  ConfigMap,
  Container,
  Deployment,
  InfisicalSecret,
  IngressRoute,
  Namespace,
  PersistentVolumeClaim,
  Probe,
  Service,
  ServiceAccount,
} from "@intentius/chant-lexicon-k8s";

const name = "radicale";
const hostname = "dav.inevitable.fyi";
const labels = { app: name };

// Namespaced resources deliberately carry no `metadata.namespace` — the Flux
// Kustomization in home-cloud sets `targetNamespace: radicale` (chant's WK8001
// flags hardcoded namespaces in source). The Namespace object itself survives
// that transform unchanged, so this is still what creates the namespace.
export const namespace = new Namespace({ metadata: { name } });

// Identity the secrets-operator presents to Infisical for the InfisicalSecret
// below (kubernetesAuth). The `radicale-operator` machine identity on the server
// is restricted to exactly this ServiceAccount + namespace.
export const serviceAccount = new ServiceAccount({
  metadata: { name: `${name}-infisical` },
});

// Keys in the radicale project:
//   HTPASSWD_USERS    — bcrypt htpasswd file content, mounted as
//                       /etc/radicale/users by the Deployment
//   RADICALE_PASSWORD — plaintext reference copy for configuring CalDAV clients
//                       (Apple Calendar, Cal.com); not consumed by any pod
// The namespaces below are spec fields, not `metadata.namespace`, so the Flux
// namespace transform does not rewrite them.
export const auth = new InfisicalSecret({
  metadata: { name: `${name}-auth` },
  spec: {
    // Internal Service DNS — no Traefik/Cloudflare round-trip for in-cluster
    // reconciles.
    hostAPI: "http://infisical.infisical.svc.cluster.local:8080",
    resyncInterval: 60,
    authentication: {
      // Kubernetes-native auth: no stored credential.
      kubernetesAuth: {
        identityId: "72e0768b-bcc4-4bc4-a495-48bcc7b4145d",
        autoCreateServiceAccountToken: true,
        serviceAccountRef: { name: `${name}-infisical`, namespace: name },
        secretsScope: {
          projectSlug: "radicale-tx-mo",
          envSlug: "prod",
          secretsPath: "/",
        },
      },
    },
    managedSecretReference: {
      secretName: `${name}-auth`,
      secretNamespace: name,
      // Orphan = operator overwrites existing Secret data in place; the
      // materialized Secret survives CR deletion.
      creationPolicy: "Orphan",
    },
  },
});

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

export const service = new Service({
  metadata: { name, labels },
  spec: {
    type: "ClusterIP",
    selector: labels,
    ports: [{ name: "http", port: 80, targetPort: "http" }],
  },
});

export const certificate = new Certificate({
  metadata: { name: `${name}-tls` },
  spec: {
    secretName: `${name}-tls`,
    issuerRef: { name: "letsencrypt-production", kind: "ClusterIssuer" },
    dnsNames: [hostname],
  },
});

// Public CalDAV endpoint at https://dav.inevitable.fyi — Apple Calendar on and
// off the tailnet, and Cal.com in-cluster, both sync against it. Auth is
// Radicale's own htpasswd (bcrypt); everything under / requires credentials
// except the web-UI login page.
export const ingressRoute = new IngressRoute({
  metadata: { name },
  spec: {
    entryPoints: ["websecure"],
    routes: [
      {
        match: `Host(\`${hostname}\`)`,
        kind: "Rule",
        services: [{ name, port: 80 }],
      },
    ],
    tls: { secretName: `${name}-tls` },
  },
});

export const ingressRouteHttp = new IngressRoute({
  metadata: { name: `${name}-http` },
  spec: {
    entryPoints: ["web"],
    routes: [
      {
        match: `Host(\`${hostname}\`)`,
        kind: "Rule",
        // The redirect-https Middleware lives in the default namespace; this is
        // a spec-level cross-namespace reference, not metadata.namespace.
        middlewares: [{ name: "redirect-https", namespace: "default" }],
        services: [{ name, port: 80 }],
      },
    ],
  },
});
