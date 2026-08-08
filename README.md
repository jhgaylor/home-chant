# home-chant

[chant](https://github.com/INTENTIUS/chant)-based Kubernetes apps deployed to the [home-cloud](https://github.com/jhgaylor/home-cloud) k3s cluster. Each app is TypeScript-defined infrastructure compiled to plain Kubernetes YAML — the TypeScript in `apps/<name>/src/` is the source of truth; the generated `apps/<name>/k8s/manifests.yaml` is a build artifact and should never be hand-edited.

## Layout

```
packages/
  traefik-app/      # shared composite — the boilerplate every public app repeats
apps/
  <app-name>/
    src/
      infra.ts        # chant TypeScript source (Deployment, Service, ...)
    chant.config.ts
    package.json
    k8s/
      manifests.yaml     # `chant build` output — committed, not hand-edited
      kustomization.yaml # references manifests.yaml
```

## The `TraefikApp` composite

`packages/traefik-app` holds the resources every public app in this cluster
repeats verbatim: the Namespace, the Infisical ServiceAccount + InfisicalSecret
pair, the Service, and the Certificate + IngressRoute + redirect-IngressRoute
trio. Apps depend on it through a `file:` reference and call it like this:

```ts
const app = TraefikApp({
  name, host: hostname, port,
  infisical: { identityId, projectSlug, secretName },
});
export const { namespace, serviceAccount, secret, service,
               certificate, ingressRoute, ingressRouteHttp } = app;
```

`TraefikEndpoint` is the same thing minus the Namespace and Infisical pair — for
a second web surface in an existing namespace (mem0's dashboard is the only one).

**It deliberately does not cover the Deployment.** The five converted apps share
almost nothing there: calcom needs a startupProbe with a 45-failure runway, mem0
replaces the image's CMD with `alembic && uvicorn`, radicale runs as uid 2999
with an fsGroup, ntfy and mealie mount different volumes, and only calcom keeps
the default RollingUpdate. A prop per variation is how you arrive at the k8s
lexicon's own `WebApp` — thirty-odd optional props that still can't express
`command`. Workloads stay hand-written.

`hello-chant` doesn't use the composite either: it lives in `default` with no
Namespace, no secrets, and Tailscale annotations on its Service. Forcing it
through would mean props that exist for one caller.

Because the dependency is a `file:` link and Node resolves links to their real
path, `packages/traefik-app` needs its own `npm ci` before an app can build —
CI does this as a separate step.

home-cloud's cluster uses Traefik `IngressRoute` CRDs rather than standard Kubernetes `Ingress`. The k8s lexicon types those natively (`IngressRoute`, `IngressRouteTCP`, `IngressRouteUDP`, `Middleware`, `TraefikService`, ...), alongside the other operator CRDs this cluster runs — cert-manager's `Certificate`, Infisical's `InfisicalSecret`, CNPG's `Cluster`, and Flux's `GitRepository`/`Kustomization`/`HelmRelease`. They're all just `new X({...})` imported from `@intentius/chant-lexicon-k8s`; no CRD in home-cloud currently needs an escape hatch.

## Adding a new app

```bash
mkdir -p apps/<name>/src && cd apps/<name>
npx chant init --lexicon k8s
# edit src/infra.ts — see apps/hello-chant/src/infra.ts for the shape.
# For an existing app, import it instead of hand-writing:
#   npx chant import --kustomize ../../../home-cloud/k8s/<name> --output src
npx chant lint src
npx chant build src --lexicon k8s --format yaml --output k8s/manifests.yaml
```

Then onboard it to Flux by adding a `Kustomization` (pointing at `apps/<name>/k8s`) to `clusters/home/apps/home-chant.yaml` in the home-cloud repo — see [home-cloud's deploying-apps.md](https://github.com/jhgaylor/home-cloud/blob/main/docs/deploying-apps.md). Pick an app name that doesn't collide with anything already running in the `default` namespace — Deployment selectors are immutable, so a name collision blocks Flux from ever applying it.

## CI

`.github/workflows/validate.yml` discovers every app under `apps/*/` and, for each, runs `chant lint` and rebuilds `k8s/manifests.yaml`, failing if the committed output has drifted from the TypeScript source.

## Namespace

Resources intentionally don't hardcode a namespace (chant's linter flags this as `WK8001` — hardcoded namespaces should come from deploy-time config, not source). The namespace is set once, at the Flux `Kustomization` level (`spec.targetNamespace`), in home-cloud.
