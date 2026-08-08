import { Kustomization } from "@intentius/chant-lexicon-k8s";

/**
 * The Flux `Kustomization` that tells the cluster to reconcile one app in this
 * repo. chant types the Flux CRDs but ships no composite for them the way it
 * does for Argo (INTENTIUS/chant#1590), so this is ours.
 *
 * The matching `GitRepository` deliberately stays in home-cloud. It is the one
 * bootstrap edge that cannot live here: something has to know how to fetch this
 * repo before anything in it can be read. Everything downstream of that fetch
 * describes itself.
 */
export interface FluxAppForProps {
  /** Directory under apps/ — also the Kustomization's name suffix. */
  app: string;
  /**
   * Namespace the app's resources land in. Apps carry no `metadata.namespace`
   * in source (chant's WK8001), so this is where it gets decided.
   */
  targetNamespace: string;
  /**
   * Flux Kustomizations this one waits for, by name. These live in home-cloud
   * (`cert-manager`, `traefik`, `longhorn`, `cnpg`, `infisical-operator`), so
   * they are strings rather than references — a cross-repo edge is not
   * something this side can typecheck. Getting one wrong shows up as a
   * Kustomization stuck on DependencyNotReady, naming the missing dependency.
   */
  dependsOn: string[];
  /** Reconcile interval. Defaults to 10m, matching everything else here. */
  interval?: string;
  /**
   * Whether Flux garbage-collects app resources that leave the build output.
   * Defaults true — the app-level Kustomizations should prune normally. It is
   * the control-plane Kustomization one layer up (in home-cloud) that runs
   * with prune off, so a bad build here cannot cascade into deleting an app.
   */
  prune?: boolean;
}

export function FluxAppFor(props: FluxAppForProps) {
  const { app, targetNamespace, dependsOn } = props;
  return new Kustomization({
    // Namespace is set by the control-plane Kustomization's targetNamespace
    // (flux-system), not hardcoded here — same WK8001 reasoning as the apps.
    metadata: { name: `home-chant-${app}` },
    spec: {
      interval: props.interval ?? "10m",
      sourceRef: { kind: "GitRepository", name: "home-chant" },
      path: `./apps/${app}/k8s`,
      targetNamespace,
      prune: props.prune ?? true,
      wait: true,
      dependsOn: dependsOn.map((name) => ({ name })),
    },
  });
}
