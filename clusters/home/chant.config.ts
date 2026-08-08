import type { ChantConfig } from "@intentius/chant";
import type { K8sChantConfig } from "@intentius/chant-lexicon-k8s";

export default {
  lexicons: ["k8s"],
  ownership: { stack: "home-chant-control-plane" },
  k8s: { profiles: { home: { context: "home-cloud" } } } satisfies K8sChantConfig,
} satisfies ChantConfig;
