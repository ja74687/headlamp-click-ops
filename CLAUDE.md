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

Headlamp desktop 0.46 (checked in its bundled frontend) loads that `plugins\` directory only
with **Plugin Development Mode** on (Settings → Plugins, "Load development plugins"; stored as
`developmentPlugins` in `%APPDATA%\Headlamp\settings.json`). With it off, a copy there is
silently skipped. Same-named plugins resolve development > user (`user-plugins\`, catalog
installs) > shipped, so with the mode on a dev copy overrides the catalog version, and
turning it off falls back to the catalog one. It is a security setting with its own
confirmation dialog — the user flips it, not an agent.

Releases are tag-driven: bump `version` in `package.json`, then push a `v*` tag.
`.github/workflows/release.yml` builds, packages, rewrites `artifacthub-pkg.yml` with the new
version/URL/checksum, commits that back to `main`, and creates the GitHub Release.

## Architecture

A single-bundle Headlamp plugin. `src/index.tsx` is the only entrypoint: it registers six
sidebar entries + routes (Access Builder, Namespace Access, Resource Builder, Traefik, Cluster
Monitor, Sidebar Settings) and one `registerSidebarEntryFilter`. Everything else is reached
from there.
A new page also needs its name adding to `OWN_ENTRIES` in `SidebarSettingsPage.tsx`.

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
- Because of that, `applyResources` is wrong for both a *create* (it quietly updates whatever
  already sits under the name) and a form *edit* (it re-reads before the PUT, so it can never
  notice a change made since the form was loaded). Use `createResource(s)` — POST only, a 409
  is an error — and `updateResource(live, desired)`, which PUTs with the resourceVersion of
  the object the edit started from, so a concurrent change fails with 409. Creating an
  account (and importing one that is not the same account) also runs `findExisting` first, so
  a clash is reported before anything is written rather than half-way through.
  `applyResources` remains for re-applying the plugin's own objects (account edits, imports
  of the same account).
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

The label and name fallbacks carry no namespace, while the role, cluster-read and
cluster-binding names are cluster-scoped. An account name is therefore unique per cluster,
not per namespace: the create guard above enforces that, and `bindingBelongsTo` refuses a
binding whose subject is a same-named ServiceAccount in another namespace, so that legacy
duplicates do not prune each other's bindings.

**`ManagedAccount.roleName` is not necessarily ours.** It comes from the `roleRef` of the
first binding discovery matched, and matching is by subject first — a binding someone made
with kubectl can point the account at a shared Role or at `cluster-admin`. Role deletes
(`deleteRole`, the stale-Role cleanup) therefore go through `deleteIfLabelled` with
`accountLabels(name)`, and the plan only lists them when `ownsRoleName` holds. Never delete
a role by a discovered name without that check.

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
denial means the account cannot use Headlamp. Reviews also send `serviceAccountGroups`, or
grants made to `system:serviceaccounts` / `system:authenticated` read as denied, and the
per-namespace check asks for a permission taken from the account's own first rule
(`representativeAttrs`), not a fixed "list pods".

`src/lib/plan.ts` turns an edit into an explicit list of create/update/recreate/delete steps,
which the confirm dialog renders. It mirrors `reconcileEdit` and has to stay in step with it —
the reconciler is the thing that acts, the plan only describes. Both are pure enough to test.

`src/lib/portable.ts` is the export/import format (`version: 1`). It carries permissions only,
never tokens: an exported file is something people commit. `parseBundle` validates
defensively — the file comes from outside the cluster and drives RBAC writes, so unknown
fields are reported rather than coerced.

`src/lib/orphans.ts` finds managed objects whose ServiceAccount is gone, keyed on the account
*name* (the same key the naming convention and labels use, and what a recreated ServiceAccount
would collide with). `orderForDeletion` puts bindings before roles so an interrupted cleanup
leaves a role with no binding, never a binding referencing a deleted role. When the
ServiceAccount list itself fails, `classifyOrphans` reports nothing: with no live accounts
every managed object looks abandoned, and "Remove all" would strip every account's access.

`staleRoleNamespaces` (in `plan.ts`, used by both the plan and `reconcileEdit`) covers the one
deletion a kind change does not: a single-namespace account moved to another namespace keeps
a Role, and the old one has to go.

`src/lib/tokenRequest.ts` issues short-lived credentials via
`POST .../serviceaccounts/<name>/token`. Unlike the Secret path it gets no CA back, so the CA
comes from `kube-root-ca.crt` (every namespace since 1.20) with cluster-info as fallback. The
API server silently clamps the lifetime to its own maximum — `wasClamped` detects that, and it
is normal rather than an error.

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

`src/useNamespaceFilter.ts` (used by Resource Builder and Traefik) reads
`state.filter.namespaces` via `useSelector` and writes back with
`dispatch({ type: 'filter/setNamespaceFilter', payload })` to stay in sync with Headlamp's
topbar filter. This reaches into Headlamp's Redux store directly and is not part of the plugin
API — treat it as fragile across Headlamp versions, and note the selector must tolerate both
`Set` and array shapes.

### Traefik: forms over CRDs, never clobber what the form doesn't own

`src/lib/traefik.ts` holds all of it (I/O plus pure logic, tested in `traefik.test.ts`); the
UI is `TraefikPage` -> `TraefikMiddlewaresTab` / `TraefikRoutesTab` (+ `TraefikRouteDialog`,
`TraefikMiddlewareFields`). Traefik **v3 only** (`traefik.io/v1alpha1`); `detectTraefik`
reports a missing API or a v2 install (`traefik.containo.us`) instead of throwing.

- **Editing a Middleware starts from the live `spec.<type>`** (`buildTypeSpec`) and only
  sets or deletes the fields the form renders. `applyResources` replaces `spec` wholesale,
  so building it from the form alone would silently drop `contentSecurityPolicy`,
  `ipStrategy.excludedIPs` and the like. Only single-type middlewares the form fully
  understands are editable (`isFormEditable`); chains, forwardAuth etc. are read-only.
- The managed-by label (`app.kubernetes.io/managed-by: headlamp-click-ops`, deliberately
  not the Access Builder value that `orphans.ts` keys on) goes on **new** objects only —
  stamping it on an existing one would overwrite `managed-by: Helm`.
- Basic auth uses a `kubernetes.io/basic-auth` Secret `<mw>-basic-auth` (username/password,
  which Traefik reads as-is — no hashing, one user per middleware). It is written before the
  Middleware, and deleted with it only when it carries our labels and
  `click-ops/for-middleware=<name>`. Creating refuses to take over an existing Middleware or
  a Secret it did not make.
- Attaching: Ingress annotation `traefik.ingress.kubernetes.io/router.middlewares` as
  `<namespace>-<name>@kubernetescrd`; IngressRoute `spec.routes[].middlewares`. Entries the
  dialog does not manage (`@file`, other namespaces) keep their place, and kept middlewares
  keep their position — order is execution order. Only same-namespace middlewares are
  offered, because cross-namespace refs need Traefik's `allowCrossNamespace`.
- Writes are JSON merge patches carrying `metadata.resourceVersion`, so a concurrent change
  is a 409 ("changed meanwhile"), not a silent overwrite. A merge patch replaces arrays, so
  `spec.routes` is always sent whole, copied from the live object.
- **What Traefik actually reads decides what the page lets you write.** Middleware objects
  are read only by the `kubernetesCRD` provider, the `router.*` annotations only by the native
  `kubernetesIngress` provider, and installs that replaced ingress-nginx often run only
  `kubernetesIngressNGINX`, which enforces `nginx.ingress.kubernetes.io/*` annotations and
  ignores Traefik's own. `detectTraefikRuntime` reads the providers off the single Traefik
  DaemonSet/Deployment's args (flag names compared in lower case, a provider counts as on only
  through its own switch), `ingressHandling` says which provider serves an Ingress (by the
  IngressClass `spec.controller`), and `ingressVerdicts` / `ingressRouteVerdict` allow, refuse
  or require confirmation for each write. Anything not established — no permission to list
  workloads, several Traefiks, a config file, a class-less or annotation-classed Ingress — is
  `unknown` and needs explicit confirmation, never a guess: an attached middleware that
  nothing reads looks like protection on an admin panel that has none. For compat-mode
  Ingresses the page shows the protection from the nginx annotations (`nginxProtection`)
  instead; whether `ssl-redirect` defaults to on with TLS there is undocumented, so it is shown
  as "not set".
- **Editing nginx protection** (`src/lib/nginxAnnotations.ts`, `NginxProtectionDialog`) is
  offered only where `nginxEditVerdict` says the compatibility provider enforces it.
  `buildNginxChange` emits only the annotations whose value changes, writes the list under the
  name already in use (`whitelist-` vs `allowlist-source-range`), and clears both when the list
  is emptied. A new password is an Opaque Secret `<ingress>-basic-auth` with key `auth` holding
  an htpasswd line in `$apr1$` (`src/lib/htpasswd.ts`: own MD5 + MD5-crypt, since Web Crypto has
  no MD5; tests pin it to `openssl passwd -apr1`, fed through stdin — on Windows an argument
  reaches openssl in the ANSI code page, which produced a wrong "expected" value once). The
  Secret is written before the annotations point at it and removed after they stop, and only
  when it carries `click-ops/for-ingress=<name>`; a Secret set up by hand is never touched.
  Weakening changes (emptying the allowlist, adding a `/0` entry, dropping the password,
  dropping the forced redirect, changing a password another Ingress shares) need an explicit
  confirmation (`nginxRisks`). Sections the user did not change are not written at all, not
  even normalised.
- **The annotations mean what Traefik's source says, by version** (`compatSemantics`, read in
  `pkg/provider/kubernetes/ingress-nginx` of v3.6/v3.7, because the docs only list the names):
  the allowlist annotations exist from 3.7 on (before that a list is shown as ignored and
  cannot be edited); before 3.7 a broken auth Secret is only logged and the route stays open;
  3.7 redirects TLS Ingresses to HTTPS by default; booleans are `EqualFold(v, "true")`, so
  `"1"` is off; a present-but-empty `allowlist-source-range` switches the whitelist off too.
  The version comes from the image tag — no tag, no claim.
- `saveNginxProtection` orders writes so a failure part-way never leaves the Ingress pointing
  at missing credentials: a new Secret before the patch, a Secret already in use after it, a
  fresh Secret rolled back only if the re-read Ingress does not point at it, and our own
  Secret deleted last and only when no other Ingress in the namespace uses it.
- Per-route access logs are a tri-state (absent / true / false). Old CRDs prune
  `routes[].observability` without an error, so after saving an IngressRoute the page reads
  it back (`observabilityDropped`). They only work when access logging is on in Traefik's
  static config, which the page cannot change.

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
- The `[access-builder]` console prefix predates the rename to click-ops and is what
  `discovery.ts` logs with. Keep it consistent rather than mixing.
- Base64 helpers in `src/lib/kvResources.ts` go through `TextEncoder`/`TextDecoder`; plain
  `btoa`/`atob` corrupt non-ASCII Secret values. Use `tryDecodeBase64ToUtf8`, which decodes
  with `fatal: true` and returns `null` for bytes that are not valid UTF-8 — the edit form
  keeps those as opaque base64 (`alreadyEncoded`). A non-fatal decoder silently substitutes
  U+FFFD, so binary Secret values came back corrupted after a save.
- `listConfigMaps`/`listSecrets` take the active namespaces and query per namespace; only an
  empty list falls back to the cluster-wide endpoint. Listing every Secret in the cluster
  pulls all of their `data` into the browser. An unreadable namespace is skipped, but when
  nothing at all can be read they throw, so the tab shows the error instead of an empty list.
- `KeyValueEditor` with `hideValues`: MUI drops `type` on a `multiline` field (it renders a
  textarea), so `type="password"` there masks nothing. A masked value is a single-line
  password input instead, and browsers strip line breaks from those — so a masked multi-line
  value (a PEM key) is read-only until revealed, and a multi-line paste into a masked field is
  spliced in by `onPaste` rather than left to the browser. Don't "simplify" this back to one
  field.
- A Secret type's required keys are applied only when the user picks the type
  (`withRequiredKeys`), never in an effect on the type: loading a TLS Secret for editing would
  run it and drop `ca.crt`.
- `YamlPreview` and `KvResourceTable` are the shared preview card and ConfigMap/Secret list;
  use them rather than copying the markup again.
- Target is Headlamp **0.41+** / `@kinvolk/headlamp-plugin` **0.13.x**. The plugin filter API
  there supports show/hide only — no reparenting — which is why Sidebar Settings can't build a
  collapsible "More" submenu.
