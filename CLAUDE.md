# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout note

The git repository root is `headlamp-click-ops/`, one level below the outer `HeadLamp/`
working directory. All paths below are relative to `headlamp-click-ops/`.

For Headlamp SDK patterns this file doesn't cover, read the plugins shipped inside the SDK:
`node_modules/@kinvolk/headlamp-plugin/examples/` (pod-counter, sidebar, tables, details-view,
resource-charts) and `official-plugins/` (cert-manager and flux for CRDs, keda for map views,
prometheus and opencost for charts).

## Commands

`node_modules/` is not checked in — run `npm install` first.

```bash
npm install
npm start                 # watch-mode build (headlamp-plugin start)
npm run build             # production bundle -> dist/main.js
npm run tsc               # type check
npm run lint              # eslint; lint-fix to autofix
npm run format            # prettier
npm run test              # vitest wrapper — currently fails to spawn on Windows
```

Run the tests directly instead; the SDK's vite config is what sets up jsdom, and without
`-c` the suites that transitively import ApiProxy die on `window is not defined`:

```bash
npx vitest run -c node_modules/@kinvolk/headlamp-plugin/config/vite.config.mjs src/lib
npx vitest run -c node_modules/@kinvolk/headlamp-plugin/config/vite.config.mjs src/lib/rbac.test.ts
```

CI (`.github/workflows/ci.yml`) runs the checks directly, not via the npm scripts, and is
stricter than `npm run lint`:

```bash
npx tsc --noEmit
npx eslint -c package.json --max-warnings 0 --ext .js,.ts,.tsx src/
```

Warnings fail CI, so `console.*` calls need an inline `// eslint-disable-next-line no-console`
(the existing debug logging does this). ESLint and Prettier config live inside `package.json`
(`eslintConfig` / `prettier` keys), not in separate dotfiles.

To see a change in the real app, build and copy `dist/main.js` **and** `package.json` into
Headlamp's plugin directory (`%APPDATA%\Headlamp\Config\plugins\headlamp-click-ops\` on
Windows). `package.json` is not optional — Headlamp reads
`devDependencies["@kinvolk/headlamp-plugin"]` from it for the SDK compatibility check and
disables the plugin as "incompatible" if it is missing.

Releases are tag-driven: bump `version` in `package.json`, then push a `v*` tag.
`.github/workflows/release.yml` builds, packages, rewrites `artifacthub-pkg.yml` with the new
version/URL/checksum, commits that back to `main`, and creates the GitHub Release.

## Architecture

A single-bundle Headlamp plugin. `src/index.tsx` is the only entrypoint: it registers four
sidebar entries + routes (Access Builder, Resource Builder, Cluster Monitor, Sidebar Settings)
and one `registerSidebarEntryFilter`. Everything else is reached from there.

Split of responsibilities:

- `src/lib/*.ts` — all Kubernetes I/O and pure logic. No React.
- `src/*.tsx` — MUI-based UI. Pages compose tab components (`ResourceBuilderPage` ->
  `ConfigMapsTab`/`SecretsTab`, `AccessBuilderPage` -> `ManagedAccountsList`).

### Kubernetes access goes through raw ApiProxy, not resource classes

Almost all cluster access uses `request` / `post` / `patch` from
`@kinvolk/headlamp-plugin/lib/ApiProxy` against hand-written API paths (`/api/v1/...`,
`/apis/<group>/<version>/...`). `K8s.ResourceClasses` is used only for the
`Namespace.useList()` pickers. Follow that convention — the plugin needs subresources
(`nodes/<name>/proxy/stats/summary`), label selectors and cross-namespace list endpoints that
the resource classes don't expose cleanly.

`src/lib/apply.ts` is the write layer for everything:

- `applyResources` does create-or-update as **POST, and on conflict re-GET then PUT**. There
  is no server-side apply.
- The PUT body is built by `mergeOntoExisting`, not from the desired object alone: labels and
  annotations are merged and everything the caller did not restate (ownerReferences, a
  ConfigMap's `binaryData`, a token Secret's generated `data`) is carried over from the live
  object. Top-level keys the caller *does* set still replace wholesale, so dropping a key from
  a ConfigMap still drops it. Keep that asymmetry — a blind replace silently detaches
  Helm-managed objects from their release.
- `kindToPlural` is a hardcoded map with a pluralisation fallback — add new kinds to the map
  rather than trusting the fallback.
- `detectApiServerUrl` tries `kube-public/cluster-info` first, then the `kubernetes` Endpoints
  in `default`.

### Access Builder: convention-based ownership

Created objects carry the label `app.kubernetes.io/managed-by=headlamp-access-builder`
(`MANAGED_BY_LABEL`/`MANAGED_BY_VALUE` in `src/lib/rbac.ts`) plus
`access-builder/account=<sa-name>`, and names are derived deterministically by `deriveNames`:
`<sa>`, `<sa>-role`, `<sa>-binding[-<namespace>]`, `<sa>-token`.

`src/lib/discovery.ts` reverse-engineers accounts from the cluster using fallbacks in order:
subject match on the ServiceAccount -> the `access-builder/account` label -> the name-prefix
convention -> a direct GET at the conventional binding path. **Changing `deriveNames` or the
label constants breaks the Manage view for already-created accounts** — the naming scheme is a
wire contract, not an implementation detail.

`ManagedAccount.bindings` keeps each RoleBinding's namespace and name paired in one array.
Never split them into two arrays sorted independently: the prune step in `reconcileEdit`
addresses bindings by `(namespace, name)`, and a mismatched pair deletes a name that does not
exist there — swallowed as a 404 — leaving the real binding, and its access, in place.

**The cluster-read bundle.** A RoleBinding grants nothing cluster-scoped even when its
`roleRef` is a ClusterRole, so an account built from namespaced bindings alone cannot list
namespaces, read nodes or read metrics — Headlamp is unusable for it. `buildUiClusterRead`
emits an optional `<sa>-cluster-read` ClusterRole + ClusterRoleBinding for that, at the level
chosen by `BuildInput.uiAccess` (`none` / `namespaces` / `metrics` / `workloads` / `kubelet`,
cumulative — `LEVEL_ORDER` plus `atLeast()` drive both rule building and detection, so a new
level means one array entry and one branch, not a rewrite). `levelFromUiAccessRules` reads the
level back off a live ClusterRole and must test most-specific first; note it matches on
(group, resource) pairs, because `metrics.k8s.io` also has a `pods` resource and reading pod
metrics is a different permission from listing pods.
Those two objects are tagged `access-builder/purpose: ui-cluster-read` and deliberately carry
**no** `access-builder/account` label; discovery filters them out before matching, because
they name the ServiceAccount as a subject and would otherwise be mistaken for the account's
own ClusterRoleBinding and flip its scope to cluster-wide.

`rbac.ts` is pure (input -> manifest objects) and is covered by `src/lib/rbac.test.ts`.

One non-obvious rule in `roleKind()`: scope `Namespaced` with **more than one** namespace
still produces a **ClusterRole** plus one RoleBinding per namespace — the standard Kubernetes
multi-namespace idiom. Note the consequence: permissions on cluster-scoped resources written
into that ClusterRole (e.g. `namespaces`, `nodes`) do **not** take effect, because a
RoleBinding only grants inside its own namespace. Anything the user needs cluster-wide requires
a separate ClusterRoleBinding.

`src/lib/accessCheck.ts` verifies an account against the API server with SubjectAccessReview
(`POST /apis/authorization.k8s.io/v1/subjectaccessreviews`, `spec.user =
system:serviceaccount:<ns>:<name>`) rather than re-reading the manifests. `allowed: null` means
"could not determine" and is deliberately distinct from `false`; when *every* check comes back
null it is the operator's own permission to create reviews that is missing, not the account's.
Checks marked `optional` map to panels that are allowed to stay empty — only a non-optional
denial means the account cannot use Headlamp.

Long-lived tokens: a `kubernetes.io/service-account-token` Secret is created and `waitForToken`
polls it (750 ms, 20 s cap) until the controller fills in `token` and `ca.crt`, which then feed
`buildKubeconfig` in `src/lib/kubeconfig.ts`.

### Sidebar Settings: the filter is also the discovery mechanism

Headlamp gives no API to enumerate sidebar entries, so the `registerSidebarEntryFilter` callback
in `index.tsx` does double duty — it records every entry it sees (recursively, via
`recordDiscovered`) into the store in `src/lib/sidebarSettings.ts` *and* returns `null` for
hidden ones. Consequences to respect:

- The filter runs on every sidebar render, so `getCurrentSettings()` reads a module-level cache
  (`cachedSettings`), never `localStorage`. Keep that path synchronous and allocation-light.
- `recordDiscovered` no-ops when nothing actually changed and bumps a version counter otherwise;
  the page consumes it via `useSyncExternalStore`. Skipping the equality check causes a render
  loop.
- `sidebar-settings` is in `PROTECTED_ENTRIES` and is excluded from discovery — it must never be
  hideable, or the user loses the way back.
- Saving calls `registerSidebarEntryFilter(e => e)` — registering a throwaway no-op filter is
  what forces Headlamp to re-run the filter chain and apply changes without a restart.

`SidebarSettingsPage.tsx` rebuilds the parent/child tree that Headlamp doesn't expose, stacking
three heuristics: the `KNOWN_HIERARCHY` map of Headlamp's built-in categories, longest-prefix
URL matching, and the CRD `group-<group>` / `<plural>.<group>` naming convention. New Headlamp
built-ins usually need a line in `KNOWN_HIERARCHY`.

Settings persist in `localStorage` under `click-ops:sidebar-settings` — per-browser/per-install,
not in the cluster.

### Namespace filter sync (undocumented Headlamp internals)

`ResourceBuilderPage.tsx` reads `state.filter.namespaces` via `useSelector` and writes back with
`dispatch({ type: 'filter/setNamespaceFilter', payload })` to stay in sync with Headlamp's
topbar filter. This reaches into Headlamp's Redux store directly and is not part of the plugin
API — treat it as fragile across Headlamp versions, and note the selector must tolerate both
`Set` and array shapes.

### Cluster Monitor: degrade, never throw

`src/lib/metrics.ts` pulls from two optional sources — metrics-server
(`/apis/metrics.k8s.io/v1beta1/{nodes,pods}`) and the kubelet stats summary via
`nodes/<name>/proxy/stats/summary`. Both are frequently absent (not installed, or missing
`nodes/proxy` RBAC), so every fetch is wrapped and failures surface as `null` fields plus
strings in `NodeRow.errors` / a `metricsServerError`. The UI shows a warning line for those
sections instead of failing the page. Preserve that pattern when adding metrics.

Refreshes are guarded: a run is skipped while another is in flight, and the interval does not
fire for a hidden tab (it catches up on `visibilitychange`). One refresh fans out to a full pod
list plus a kubelet call per node, so overlapping runs are expensive.

Every endpoint this page uses is cluster-scoped (`/api/v1/nodes`, `/api/v1/pods` and
`/api/v1/persistentvolumeclaims` across all namespaces, `nodes/proxy`, `metrics.k8s.io`), so it
is blank for any account that only holds namespaced RoleBindings.

`parseQuantity` handles both SI (`n`, `u`, `m`, `k`, `M`, `G`...) and binary (`Ki`, `Mi`,
`Gi`...) suffixes and is the single place quantity parsing should happen.

PVC usage: kubelet often omits `volume[].pvcRef`, so a fallback map from pod
`spec.volumes[].persistentVolumeClaim.claimName` is built and matched by volume name. Some
provisioners (microk8s hostpath) report no usage at all — capacity-only display is expected.

## Gotchas

- `js-yaml` is imported by `apply.ts` and `kubeconfig.ts` but is **not** a declared dependency —
  it resolves transitively through `@kinvolk/headlamp-plugin`. Don't "fix" the imports by
  assuming it's direct; if it ever needs pinning, add it explicitly.
- The `[access-builder]` console prefix predates the rename to click-ops and is used across
  `index.tsx`, `discovery.ts` and `kvResources.ts`. Keep it consistent rather than mixing.
- Base64 helpers in `src/lib/kvResources.ts` go through `TextEncoder`/`TextDecoder`; plain
  `btoa`/`atob` corrupt non-ASCII Secret values. Use `tryDecodeBase64ToUtf8`, which decodes
  with `fatal: true` and returns `null` for bytes that are not valid UTF-8 — the edit form
  keeps those as opaque base64 (`alreadyEncoded`). A non-fatal decoder silently substitutes
  U+FFFD, so binary Secret values came back corrupted after a save.
- `listConfigMaps`/`listSecrets` take the active namespaces and query per namespace; only an
  empty list falls back to the cluster-wide endpoint. Listing every Secret in the cluster
  pulls all of their `data` into the browser.
- Target is Headlamp **0.41+** / `@kinvolk/headlamp-plugin` **0.13.x**. The plugin filter API
  there supports show/hide only — no reparenting — which is why Sidebar Settings can't build a
  collapsible "More" submenu.
