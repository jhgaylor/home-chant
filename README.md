# home-chant

[chant](https://github.com/INTENTIUS/chant)-based Kubernetes apps deployed to the [home-cloud](https://github.com/jhgaylor/home-cloud) k3s cluster. Each app is TypeScript-defined infrastructure compiled to plain Kubernetes YAML — the TypeScript in `apps/<name>/src/` is the source of truth; the generated `apps/<name>/k8s/manifests.yaml` is a build artifact and should never be hand-edited.

## Layout

```
apps/
  <app-name>/
    src/
      infra.ts        # chant TypeScript source (Deployment, Service, ...)
      crds.ts          # generic CRD escape hatch (Traefik IngressRoute, ...)
    chant.config.ts
    package.json
    k8s/
      manifests.yaml     # `chant build` output — committed, not hand-edited
      kustomization.yaml # references manifests.yaml
```

home-cloud's cluster uses Traefik `IngressRoute` CRDs rather than standard Kubernetes `Ingress`. chant's k8s lexicon doesn't ship a typed class for that CRD, so `src/crds.ts` declares it via chant's documented CRD-wrapper path (see the comment in that file) — it still comes out of `chant build` like everything else, nothing in `k8s/` is hand-written. cert-manager's `Certificate` *is* natively typed by the k8s lexicon, so it's just `new Certificate({...})` like any other resource.

## Adding a new app

```bash
mkdir -p apps/<name>/src && cd apps/<name>
npx chant init --lexicon k8s
# edit src/infra.ts — copy apps/hello-chant/src/crds.ts over if you need
# a CRD the k8s lexicon doesn't model (check its generated/index.d.ts first)
npx chant lint src
npx chant build src --lexicon k8s --format yaml --output k8s/manifests.yaml
```

Then onboard it to Flux by adding a `Kustomization` (pointing at `apps/<name>/k8s`) to `clusters/home/apps/home-chant.yaml` in the home-cloud repo — see [home-cloud's deploying-apps.md](https://github.com/jhgaylor/home-cloud/blob/main/docs/deploying-apps.md). Most apps share the `default` namespace (`targetNamespace: default`) — pick a name that doesn't collide with anything already running there, since Deployment selectors are immutable and a collision blocks Flux from ever applying it. A larger, multi-service app can instead get its own `targetNamespace` and emit its own `Namespace` resource from source (see `apps/posthog` for the pattern) — that sidesteps collisions entirely but needs its own cross-namespace RBAC, if any, hand-authored in home-cloud rather than expressed in the app's own manifests (chant's `targetNamespace` convention means an app's Kustomization can't reach outside its own namespace).

## CI

`.github/workflows/validate.yml` discovers every app under `apps/*/` and, for each, runs `chant lint` and rebuilds `k8s/manifests.yaml`, failing if the committed output has drifted from the TypeScript source.

## Namespace

Resources intentionally don't hardcode a namespace (chant's linter flags this as `WK8001` — hardcoded namespaces should come from deploy-time config, not source). The namespace is set once, at the Flux `Kustomization` level (`spec.targetNamespace`), in home-cloud.
