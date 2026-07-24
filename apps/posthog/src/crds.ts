// Generic CRD escape hatch.
//
// The k8s lexicon ships typed classes for core/apps/batch/rbac resources plus a
// handful of common operator CRDs (cert-manager, Prometheus, Argo, Gateway API).
// It does NOT cover Traefik's `IngressRoute` (home-cloud uses this instead of
// standard Ingress), CloudNativePG's `Cluster` (home-cloud's Postgres operator),
// or Infisical's `InfisicalSecret` (home-cloud's runtime secrets operator).
//
// chant's k8s serializer has a documented "CRD wrapper" path: an entity whose
// props carry an explicit `apiVersion`/`kind` emits those verbatim at the
// manifest root, and anything that isn't a known top-level field is nested under
// `spec`. We use that here to declare arbitrary CRDs.
//
// One wrinkle: the serializer only emits an entity if `resolveGVK(entityType)`
// returns non-null. So we pin the synthetic entityType under the `Core` group
// (which resolves to apiVersion `v1`) and then override `apiVersion` from props.
// `kind` is derived from the entityType's trailing segment, so the third path
// component must match the CRD kind exactly.
import { createResource } from "@intentius/chant/runtime";

export type CrdProps = {
  metadata: Record<string, unknown>;
  spec?: Record<string, unknown>;
  [key: string]: unknown;
};

function defineCrd(apiVersion: string, kind: string) {
  const Base = createResource(`K8s::Core::${kind}`, "k8s", {}) as new (
    props: Record<string, unknown>,
  ) => object;
  return class extends Base {
    constructor(props: CrdProps) {
      // `apiVersion` is injected as a top-level field so the serializer's
      // CRD-wrapper path picks it up. (Object.assign rather than `{ ...props }`
      // keeps chant's EVL004 "no spread from non-const source" lint happy.)
      super(Object.assign({ apiVersion }, props));
    }
  } as new (props: CrdProps) => object;
}

/** Traefik route CR — `traefik.io/v1alpha1` IngressRoute. */
export const IngressRoute = defineCrd("traefik.io/v1alpha1", "IngressRoute");

/** CloudNativePG's Postgres cluster CR — `postgresql.cnpg.io/v1` Cluster. */
export const CnpgCluster = defineCrd("postgresql.cnpg.io/v1", "Cluster");

/** Infisical secrets-operator CR — `secrets.infisical.com/v1alpha1` InfisicalSecret. */
export const InfisicalSecret = defineCrd("secrets.infisical.com/v1alpha1", "InfisicalSecret");
