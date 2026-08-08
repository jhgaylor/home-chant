import {
  Certificate,
  InfisicalSecret,
  IngressRoute,
  Namespace,
  Service,
  ServiceAccount,
} from "@intentius/chant-lexicon-k8s";

/**
 * The resources every public app in this cluster repeats verbatim.
 *
 * Scope is deliberate. This covers the parts that were identical across
 * ntfy, mealie, radicale, mem0 and calcom once the names were substituted —
 * the namespace, the Infisical identity pair, the Service, and the
 * Certificate + IngressRoute + redirect-IngressRoute trio.
 *
 * It does NOT cover the Deployment. Those five apps share almost nothing
 * there: calcom overrides nothing but needs a startupProbe with a 45-failure
 * runway, mem0 replaces the image's CMD with `alembic && uvicorn`, radicale
 * runs as uid 2999 with an fsGroup, ntfy and mealie mount different volumes,
 * and only calcom keeps the default RollingUpdate strategy. A prop for each
 * of those is how you end up with the lexicon's own WebApp — thirty-odd
 * optional props that still can't express `command`. Workloads stay
 * hand-written; this takes the boilerplate around them.
 */
/**
 * One public web surface: Service + Certificate + the IngressRoute pair.
 *
 * Split out from TraefikApp because mem0 has two of these in one namespace —
 * the API and the Next.js dashboard — sharing a single Namespace and a single
 * Infisical identity. An app with one surface should call TraefikApp.
 */
export interface TraefikEndpointProps {
  /** Endpoint name. Service, Certificate and IngressRoutes are named from it. */
  name: string;
  /** Public hostname, e.g. "mealie.inevitable.fyi". */
  host: string;
  /** Service port. `targetPort` is always the container's "http" port. */
  port: number;
  /** cert-manager ClusterIssuer. Defaults to letsencrypt-production. */
  issuer?: string;
  /** Selector labels. Defaults to `{ app: name }`. */
  labels?: Record<string, string>;
}

export function TraefikEndpoint(props: TraefikEndpointProps) {
  const { name, host, port } = props;
  const issuer = props.issuer ?? "letsencrypt-production";
  const labels = props.labels ?? { app: name };

  const service = new Service({
    metadata: { name, labels },
    spec: {
      type: "ClusterIP",
      selector: labels,
      ports: [{ name: "http", port, targetPort: "http" }],
    },
  });

  const certificate = new Certificate({
    metadata: { name: `${name}-tls` },
    spec: {
      secretName: `${name}-tls`,
      issuerRef: { name: issuer, kind: "ClusterIssuer" },
      dnsNames: [host],
    },
  });

  const ingressRoute = new IngressRoute({
    metadata: { name },
    spec: {
      entryPoints: ["websecure"],
      routes: [
        {
          match: `Host(\`${host}\`)`,
          kind: "Rule",
          services: [{ name, port }],
        },
      ],
      tls: { secretName: `${name}-tls` },
    },
  });

  // The second route exists only to carry the redirect. The redirect-https
  // Middleware lives in the default namespace; that is a spec-level
  // cross-namespace reference, not metadata.namespace.
  const ingressRouteHttp = new IngressRoute({
    metadata: { name: `${name}-http` },
    spec: {
      entryPoints: ["web"],
      routes: [
        {
          match: `Host(\`${host}\`)`,
          kind: "Rule",
          middlewares: [{ name: "redirect-https", namespace: "default" }],
          services: [{ name, port }],
        },
      ],
    },
  });

  return { service, certificate, ingressRoute, ingressRouteHttp, labels };
}

export interface TraefikAppProps {
  /** App name. Every resource is named from it. */
  name: string;
  /** Public hostname, e.g. "mealie.inevitable.fyi". */
  host: string;
  /** Service port. `targetPort` is always the container's "http" port. */
  port: number;
  /**
   * Infisical wiring. Omit for an app with no runtime secrets — no
   * ServiceAccount and no InfisicalSecret are emitted.
   */
  infisical?: {
    /** The `<name>-operator` machine identity on the Infisical server. */
    identityId: string;
    /** Project slug on the Infisical server (auto-generated at creation). */
    projectSlug: string;
    /**
     * Name of the materialized Secret and of the CR itself. Not derivable:
     * ntfy and radicale use `<name>-auth`, the rest use `<name>-secrets`.
     */
    secretName: string;
  };
  /** cert-manager ClusterIssuer. Defaults to letsencrypt-production. */
  issuer?: string;
  /** Extra labels merged into the Service and Deployment selector labels. */
  labels?: Record<string, string>;
}

/**
 * Namespaced resources deliberately carry no `metadata.namespace` — the Flux
 * Kustomization in home-cloud sets `targetNamespace` per app (chant's WK8001
 * flags hardcoded namespaces in source). The Namespace object itself survives
 * that transform unchanged, so this is still what creates the namespace.
 *
 * The namespaces that DO appear below are spec fields, not `metadata.namespace`
 * — the Flux transform does not rewrite those, so they have to be literal.
 */
export function TraefikApp(props: TraefikAppProps) {
  const { name, host, port } = props;
  const issuer = props.issuer ?? "letsencrypt-production";
  const labels = props.labels ?? { app: name };

  const namespace = new Namespace({ metadata: { name } });

  // Identity the secrets-operator presents to Infisical (kubernetesAuth). The
  // `<name>-operator` machine identity on the server is restricted to exactly
  // this ServiceAccount + namespace; the operator mints short-lived tokens.
  const serviceAccount = props.infisical
    ? new ServiceAccount({ metadata: { name: `${name}-infisical` } })
    : undefined;

  const secret = props.infisical
    ? new InfisicalSecret({
        metadata: { name: props.infisical.secretName },
        spec: {
          // Internal Service DNS — no Traefik/Cloudflare round-trip for
          // in-cluster reconciles.
          hostAPI: "http://infisical.infisical.svc.cluster.local:8080",
          resyncInterval: 60,
          authentication: {
            // Kubernetes-native auth: no stored credential.
            kubernetesAuth: {
              identityId: props.infisical.identityId,
              autoCreateServiceAccountToken: true,
              serviceAccountRef: {
                name: `${name}-infisical`,
                namespace: name,
              },
              secretsScope: {
                projectSlug: props.infisical.projectSlug,
                envSlug: "prod",
                secretsPath: "/",
              },
            },
          },
          managedSecretReference: {
            secretName: props.infisical.secretName,
            secretNamespace: name,
            // Orphan = operator overwrites existing Secret data in place; the
            // materialized Secret survives CR deletion.
            creationPolicy: "Orphan",
          },
        },
      })
    : undefined;

  const endpoint = TraefikEndpoint({ name, host, port, issuer, labels });

  return {
    namespace,
    serviceAccount,
    secret,
    ...endpoint,
  };
}
