import { Deployment, Service, Container, Probe } from "@intentius/chant-lexicon-k8s";

const name = "hello-world";
const labels = { "app.kubernetes.io/name": name };

export const deployment = new Deployment({
  metadata: { name, labels },
  spec: {
    replicas: 1,
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        containers: [
          new Container({
            name: "app",
            image: "nginxdemos/hello:0.4",
            imagePullPolicy: "IfNotPresent",
            ports: [{ containerPort: 80, name: "http" }],
            resources: {
              requests: { cpu: "10m", memory: "32Mi" },
              limits: { cpu: "100m", memory: "64Mi" },
            },
            livenessProbe: new Probe({ httpGet: { path: "/", port: 80 } }),
            readinessProbe: new Probe({ httpGet: { path: "/", port: 80 } }),
          }),
        ],
      },
    },
  },
});

export const service = new Service({
  metadata: {
    name,
    labels,
    annotations: {
      "tailscale.com/expose": "true",
      "tailscale.com/hostname": name,
    },
  },
  spec: {
    selector: labels,
    ports: [{ port: 80, targetPort: 80, protocol: "TCP", name: "http" }],
  },
});
