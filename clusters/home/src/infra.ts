import { FluxAppFor } from "@home-chant/flux-app";

/**
 * The Flux Kustomization per app in this repo — the control plane for
 * home-chant's own apps, and nothing else.
 *
 * home-cloud keeps exactly two things about this repo: the `GitRepository` that
 * fetches it, and one Kustomization pointing at this project's k8s/ output.
 * Adding an app is then a change here, not there.
 *
 * Deliberately NOT in scope: the 17 infra Kustomizations in home-cloud
 * (traefik, cert-manager, longhorn, cnpg, infisical-operator and friends) and
 * the 8 other app repos. Those reconcile before this repo is ever fetched;
 * moving them would put a second git remote on the critical path of cluster
 * bootstrap, so a fetch failure here would stall the whole infra layer instead
 * of just these apps.
 *
 * The `dependsOn` names below refer to those home-cloud Kustomizations. They
 * are strings because the edge crosses a repo boundary — see FluxAppFor's own
 * comment.
 */

// Infra every public app in this repo waits on. Named here so a typo is one
// place, not six.
const INGRESS = ["cert-manager", "traefik"];
const STORAGE = "longhorn";
const SECRETS = "infisical-operator";
const POSTGRES = "cnpg";

export const helloChant = FluxAppFor({
  app: "hello-chant",
  targetNamespace: "default",
  // No PVC and no secrets — just a Certificate and IngressRoutes.
  dependsOn: [...INGRESS],
});

export const ntfy = FluxAppFor({
  app: "ntfy",
  targetNamespace: "ntfy",
  dependsOn: [STORAGE, ...INGRESS, SECRETS],
});

export const mealie = FluxAppFor({
  app: "mealie",
  targetNamespace: "mealie",
  dependsOn: [POSTGRES, STORAGE, ...INGRESS, SECRETS],
});

export const radicale = FluxAppFor({
  app: "radicale",
  targetNamespace: "radicale",
  dependsOn: [STORAGE, ...INGRESS, SECRETS],
});

export const mem0 = FluxAppFor({
  app: "mem0",
  targetNamespace: "mem0",
  dependsOn: [POSTGRES, STORAGE, ...INGRESS, SECRETS],
});

export const calcom = FluxAppFor({
  app: "calcom",
  targetNamespace: "calcom",
  dependsOn: [POSTGRES, STORAGE, ...INGRESS, SECRETS],
});
