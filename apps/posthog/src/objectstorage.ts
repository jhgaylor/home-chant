// Object storage for PostHog's exports/session-recording blobs, backed by
// home-cloud's existing Garage instance (s3.garage.svc.cluster.local:3900)
// instead of standing up MinIO/SeaweedFS like the hobby compose does — one
// S3 endpoint covers both roles hobby splits across two containers (see
// docker-compose.hobby.yml: `objectstorage` for general storage,
// `seaweedfs` for session-replay blobs specifically).
//
// The bootstrap Job mirrors home-cloud's proven pattern in
// k8s/loki/bootstrap-job.yaml: exec into garage-0, create a bucket + access
// key, write them into a Secret. The exec RBAC granting this ServiceAccount
// access to pods in the `garage` namespace can't be expressed here (chant's
// WK8001 lint forbids hardcoding a namespace on namespaced resources, and
// Flux's `targetNamespace: posthog` would force it there anyway) — it's
// hand-authored in home-cloud at k8s/posthog/bootstrap-rbac.yaml.
import {
  ServiceAccount,
  Role,
  RoleBinding,
  Job,
  Container,
} from "@intentius/chant-lexicon-k8s";

const labels = { "app.kubernetes.io/name": "posthog-bootstrap" };

export const bootstrapServiceAccount = new ServiceAccount({
  metadata: { name: "posthog-bootstrap", labels },
});

// Grants managing the one Secret this Job produces, within this app's own
// namespace. Mirrors loki-bootstrap-secret-writer.
export const bootstrapSecretWriterRole = new Role({
  metadata: { name: "posthog-bootstrap-secret-writer", labels },
  rules: [
    { apiGroups: [""], resources: ["secrets"], verbs: ["get", "list", "create"] },
    {
      apiGroups: [""],
      resources: ["secrets"],
      verbs: ["update", "patch"],
      resourceNames: ["posthog-object-storage-credentials"],
    },
  ],
});

export const bootstrapSecretWriterRoleBinding = new RoleBinding({
  metadata: { name: "posthog-bootstrap-secret-writer", labels },
  subjects: [{ kind: "ServiceAccount", name: "posthog-bootstrap" }],
  roleRef: { kind: "Role", name: "posthog-bootstrap-secret-writer", apiGroup: "rbac.authorization.k8s.io" },
});

const bootstrapScript = `set -eu
NS=posthog
SECRET=posthog-object-storage-credentials
GARAGE_NS=garage
GARAGE_POD=garage-0
BUCKET=posthog
KEY=posthog-key

if kubectl get secret "$SECRET" -n "$NS" >/dev/null 2>&1; then
  echo "Secret $NS/$SECRET already exists; nothing to do."
  exit 0
fi

echo "Waiting for garage-0 to be Ready..."
kubectl wait pod "$GARAGE_POD" -n "$GARAGE_NS" --for=condition=Ready --timeout=120s

GAR="kubectl exec $GARAGE_POD -n $GARAGE_NS -- /garage"

echo "Ensuring bucket $BUCKET exists..."
$GAR bucket create "$BUCKET" 2>/dev/null || echo "  (bucket already exists)"

echo "Ensuring key $KEY exists..."
if ! $GAR key info "$KEY" >/dev/null 2>&1; then
  $GAR key create "$KEY"
else
  echo "  (key already exists)"
fi

echo "Granting $KEY read+write on bucket $BUCKET..."
$GAR bucket allow --read --write "$BUCKET" --key "$KEY"

echo "Fetching key info..."
INFO=$($GAR key info --show-secret "$KEY")
ACCESS_KEY=$(echo "$INFO" | awk '/^Key ID:/ {print $3}')
SECRET_KEY=$(echo "$INFO" | awk '/^Secret key:/ {print $3}')

if [ -z "$ACCESS_KEY" ] || [ -z "$SECRET_KEY" ]; then
  echo "FAIL: could not parse Key ID / Secret key from garage output:"
  echo "$INFO"
  exit 1
fi

echo "Creating Secret $NS/$SECRET..."
kubectl create secret generic "$SECRET" -n "$NS" \\
  --from-literal=AWS_ACCESS_KEY_ID="$ACCESS_KEY" \\
  --from-literal=AWS_SECRET_ACCESS_KEY="$SECRET_KEY"

echo "Done."
`;

export const bootstrapJob = new Job({
  metadata: {
    name: "posthog-bootstrap",
    labels,
    annotations: { "kustomize.toolkit.fluxcd.io/force": "true" },
  },
  spec: {
    backoffLimit: 6,
    ttlSecondsAfterFinished: 86400,
    template: {
      spec: {
        serviceAccountName: "posthog-bootstrap",
        restartPolicy: "OnFailure",
        containers: [
          new Container({
            name: "bootstrap",
            image: "alpine/k8s:1.30.0",
            command: ["/bin/sh", "-c"],
            args: [bootstrapScript],
            resources: {
              requests: { cpu: "10m", memory: "32Mi" },
              limits: { memory: "64Mi" },
            },
          }),
        ],
      },
    },
  },
});
