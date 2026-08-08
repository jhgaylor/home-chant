#!/usr/bin/env node
/**
 * Guards the invariant that lets the control-plane Kustomization run with
 * prune on: a build must never silently lose an app.
 *
 * With prune enabled, an app that disappears from this project's output has its
 * Flux Kustomization garbage-collected, and deleting a Kustomization cascades
 * into pruning the app it manages — PVCs and Postgres included. A refactor that
 * dropped an export, a typo in a name, or a composite change that quietly
 * emitted five resources instead of six would all reach the cluster as a
 * deletion. This check turns every one of those into a failed PR instead.
 *
 * Deliberately derived from what is on disk rather than a hardcoded list of
 * apps, so it keeps working as apps are added without anyone remembering to
 * update it.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

// js-yaml 4 is CJS with named exports only; require it rather than fight the
// ESM interop.
const yaml = createRequire(import.meta.url)("js-yaml");

const here = import.meta.dirname;
const repoRoot = resolve(here, "../..");
const manifests = join(here, "k8s/manifests.yaml");

const errors = [];

// Every directory under apps/ that is a chant project. This is the source of
// truth for "what should be deployed".
const appsDir = join(repoRoot, "apps");
const apps = readdirSync(appsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(appsDir, d.name, "package.json")))
  .map((d) => d.name)
  .sort();

if (apps.length === 0) errors.push("found no apps under apps/ — the discovery itself is broken");

const docs = yaml.loadAll(readFileSync(manifests, "utf8")).filter(Boolean);
const kustomizations = docs.filter((d) => d.kind === "Kustomization");

// 1. Every app has a Kustomization. This is the one that prevents a silent
//    deletion: an app present on disk but missing from the output would be
//    pruned out of the cluster.
const byPath = new Map();
for (const k of kustomizations) {
  const p = k.spec?.path ?? "";
  byPath.set(p, k);
}
for (const app of apps) {
  const expected = `./apps/${app}/k8s`;
  if (!byPath.has(expected)) {
    errors.push(`app "${app}" exists on disk but no Kustomization builds ${expected} — with prune on, deploying this would DELETE ${app} and its storage`);
  }
}

// 2. No Kustomization points at an app that isn't there. Flux would just fail
//    to reconcile it, but failing here names the cause.
for (const k of kustomizations) {
  const p = k.spec?.path ?? "";
  const m = /^\.\/apps\/([^/]+)\/k8s$/.exec(p);
  if (!m) {
    errors.push(`Kustomization "${k.metadata?.name}" has an unexpected path ${JSON.stringify(p)} — expected ./apps/<name>/k8s`);
    continue;
  }
  if (!apps.includes(m[1])) {
    errors.push(`Kustomization "${k.metadata?.name}" points at ${p}, but apps/${m[1]} does not exist`);
  }
}

// 3. Names are unique. Two Kustomizations sharing a name means one silently
//    overwrites the other, and an app loses its reconciler.
const names = kustomizations.map((k) => k.metadata?.name);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
if (dupes.length) errors.push(`duplicate Kustomization names: ${[...new Set(dupes)].join(", ")}`);

// 4. Each one prunes. The app-level Kustomizations are what actually apply the
//    app; prune off there would leave removed resources behind forever.
for (const k of kustomizations) {
  if (k.spec?.prune !== true) {
    errors.push(`Kustomization "${k.metadata?.name}" has prune=${k.spec?.prune} — app Kustomizations should prune; it is the control-plane one in home-cloud that does not`);
  }
}

if (errors.length) {
  console.error(`control-plane check FAILED (${errors.length}):\n`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error(`\napps on disk (${apps.length}): ${apps.join(", ")}`);
  console.error(`Kustomizations built (${kustomizations.length}): ${names.join(", ")}`);
  process.exit(1);
}

console.log(`control-plane check passed: ${apps.length} apps, ${kustomizations.length} Kustomizations, 1:1`);
for (const app of apps) console.log(`  ${app} -> ${byPath.get(`./apps/${app}/k8s`).metadata.name}`);
