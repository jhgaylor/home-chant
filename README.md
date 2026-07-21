# home-chant

[chant](https://github.com/INTENTIUS/chant)-based Kubernetes apps deployed to the [home-cloud](https://github.com/jhgaylor/home-cloud) k3s cluster. Each app is TypeScript-defined infrastructure compiled to plain Kubernetes YAML — the TypeScript in `apps/<name>/src/` is the source of truth; the generated `apps/<name>/k8s/manifests.yaml` is a build artifact and should never be hand-edited.

## Layout

```
apps/
  <app-name>/
    src/            # chant TypeScript source (Deployment, Service, ...)
    chant.config.ts
    package.json
    k8s/
      manifests.yaml     # `chant build` output — committed, not hand-edited
      kustomization.yaml # references manifests.yaml + any hand-written CRDs
      ingressroute.yaml  # Traefik IngressRoute (public apps only)
      certificates.yaml  # cert-manager Certificate (public apps only)
```

home-cloud's cluster uses Traefik `IngressRoute` CRDs and cert-manager `Certificate` CRDs rather than standard Kubernetes `Ingress` — chant's k8s lexicon doesn't model those CRDs yet, so they're hand-written alongside the chant-generated manifests and wired together in each app's `kustomization.yaml`.

## Adding a new app

```bash
mkdir -p apps/<name>/src && cd apps/<name>
npx chant init --lexicon k8s
# edit src/infra.ts
npx chant lint src
npx chant build src --lexicon k8s --format yaml --output k8s/manifests.yaml
```

Then add `ingressroute.yaml` / `certificates.yaml` if the app needs a public hostname (see `apps/hello-world/k8s/` for a working example), and onboard it to Flux by adding a `Kustomization` (pointing at `apps/<name>/k8s`) to `clusters/home/apps/home-chant.yaml` in the home-cloud repo — see [home-cloud's deploying-apps.md](https://github.com/jhgaylor/home-cloud/blob/main/docs/deploying-apps.md).

## CI

`.github/workflows/validate.yml` discovers every app under `apps/*/` and, for each, runs `chant lint` and rebuilds `k8s/manifests.yaml`, failing if the committed output has drifted from the TypeScript source.

## Namespace

Resources intentionally don't hardcode a namespace (chant's linter flags this as `WK8001` — hardcoded namespaces should come from deploy-time config, not source). The namespace is set once, at the Flux `Kustomization` level (`spec.targetNamespace`), in home-cloud.
