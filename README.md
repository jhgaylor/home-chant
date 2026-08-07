# home-chant

[chant](https://github.com/INTENTIUS/chant)-based Kubernetes apps deployed to the [home-cloud](https://github.com/jhgaylor/home-cloud) k3s cluster. Each app is TypeScript-defined infrastructure compiled to plain Kubernetes YAML — the TypeScript in `apps/<name>/src/` is the source of truth; the generated `apps/<name>/k8s/manifests.yaml` is a build artifact and should never be hand-edited.

## Layout

```
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
