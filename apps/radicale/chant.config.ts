import type { ChantConfig } from "@intentius/chant";
import type { K8sChantConfig } from "@intentius/chant-lexicon-k8s";

export default {
  lexicons: ["k8s"],
  // Standard labels (app.kubernetes.io/managed-by + chant.intentius.io/stack)
  // on every resource, so chant's tooling can tell what it declared from the
  // Deployments the Infisical operator, CNPG and Flux create alongside them.
  // Stamped on metadata.labels only — never on spec.selector (immutable) or the
  // pod template, so turning it on rolls nothing.
  ownership: { stack: "radicale" },
  // Pin reads to this cluster explicitly. Without it, `chant kube` and
  // `lifecycle diff --live` follow whatever kubectl's ambient context happens
  // to be. The context is named home-cloud rather than k3s's stock "default"
  // precisely so this binding can fail loudly against the wrong cluster —
  // home-cloud's ansible k3s_server role renames it on the way out.
  k8s: { profiles: { home: { context: "home-cloud" } } } satisfies K8sChantConfig,
  // Build-time parameters, read as `params.<name>` in src/. Deliberately not
  // process.env: a parameter is resolved before any source file is read, so it
  // folds to a literal; an ambient env read cannot fold and chant rejects it.
  //
  //   chant build src --param issuer=letsencrypt-staging
  buildParams: {
    domain: {
      type: "string",
      default: "inevitable.fyi",
      description: "Base domain the app's public hostname hangs off.",
    },
    issuer: {
      type: "string",
      default: "letsencrypt-production",
      enum: ["letsencrypt-production", "letsencrypt-staging"],
      description: "cert-manager ClusterIssuer backing the Certificate.",
    },
  },
} satisfies ChantConfig;
