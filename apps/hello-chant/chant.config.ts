import type { ChantConfig } from "@intentius/chant";

export default {
  lexicons: ["k8s"],
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
