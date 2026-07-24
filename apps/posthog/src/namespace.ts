import { Namespace } from "@intentius/chant-lexicon-k8s";

// Namespace is cluster-scoped (no `.metadata.namespace` field of its own), so
// naming it here isn't the "hardcoded namespace" WK8001 warns about — every
// *namespaced* resource in this app still omits `metadata.namespace` and gets
// it from the Flux Kustomization's `targetNamespace: posthog` instead.
export const namespace = new Namespace({
  metadata: { name: "posthog", labels: { "app.kubernetes.io/name": "posthog" } },
});
