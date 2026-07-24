// Traefik IngressRoute translation of hobby's Caddyfile path-routing table
// (Caddy did pure TLS termination + path routing, no auth/rewrite logic, so
// nothing is lost in this translation). Dropped rows for services we didn't
// port: /livestream (livestream), /i/v0/ai (capture-ai, AI product),
// /i/v1/logs|traces|metrics (capture-logs, Logs/Traces products).
//
// No oauth2-proxy github-auth gate — PostHog has its own login system.
import { Certificate } from "@intentius/chant-lexicon-k8s";
import { IngressRoute } from "./crds.js";
import { HOSTNAME } from "./common.js";

const name = "posthog";
const labels = { "app.kubernetes.io/name": name };
const hostRule = `Host(\`${HOSTNAME}\`)`;

export const certificate = new Certificate({
  metadata: { name: `${name}-tls`, labels },
  spec: {
    secretName: `${name}-tls`,
    issuerRef: { name: "letsencrypt-production", kind: "ClusterIssuer" },
    dnsNames: [HOSTNAME],
  },
});

export const ingressRoute = new IngressRoute({
  metadata: { name, labels },
  spec: {
    entryPoints: ["websecure"],
    routes: [
      {
        match: `${hostRule} && (PathPrefix(\`/e\`) || PathPrefix(\`/i/v0\`) || PathPrefix(\`/i/v1/analytics/events\`) || PathPrefix(\`/batch\`) || PathPrefix(\`/capture\`))`,
        kind: "Rule",
        services: [{ name: "capture", port: 3000 }],
      },
      {
        match: `${hostRule} && PathPrefix(\`/s\`)`,
        kind: "Rule",
        services: [{ name: "replay-capture", port: 3000 }],
      },
      {
        match: `${hostRule} && (PathPrefix(\`/flags\`) || PathPrefix(\`/api/feature_flag/local_evaluation\`))`,
        kind: "Rule",
        services: [{ name: "feature-flags", port: 3001 }],
      },
      {
        match: `${hostRule} && (PathPrefix(\`/surveys\`) || PathPrefix(\`/api/surveys\`) || PathPrefix(\`/array/\`))`,
        kind: "Rule",
        services: [{ name: "hypercache-server", port: 3002 }],
      },
      {
        match: `${hostRule} && (PathPrefix(\`/public/webhooks\`) || PathPrefix(\`/public/m/\`))`,
        kind: "Rule",
        services: [{ name: "plugins", port: 6738 }],
      },
      {
        // Legacy public object-storage passthrough (exports, plugin assets).
        // Bucket "posthog" (see objectstorage.ts) matches the "/posthog"
        // path segment 1:1, same trick hobby's MinIO passthrough relies on.
        match: `${hostRule} && PathPrefix(\`/posthog\`)`,
        kind: "Rule",
        services: [{ name: "s3", port: 3900, namespace: "garage" }],
      },
      {
        // Catch-all — Django/frontend. Naturally lowest-priority: Traefik
        // ranks by rule specificity, and every rule above adds a PathPrefix
        // constraint this bare Host rule doesn't have.
        match: hostRule,
        kind: "Rule",
        services: [{ name: "web", port: 8000 }],
      },
    ],
    tls: { secretName: `${name}-tls` },
  },
});

export const ingressRouteHttp = new IngressRoute({
  metadata: { name: `${name}-http`, labels },
  spec: {
    entryPoints: ["web"],
    routes: [
      {
        match: hostRule,
        kind: "Rule",
        middlewares: [{ name: "redirect-https" }],
        services: [{ name: "web", port: 8000 }],
      },
    ],
  },
});
