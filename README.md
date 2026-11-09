<p align="center">
  <img src="assets/logo/icon.svg" alt="headlamp-click-ops" width="160" height="160" />
</p>

<h1 align="center">headlamp-click-ops</h1>

<p align="center">
  Point-and-click cluster ops for <a href="https://headlamp.dev">Headlamp</a>.<br/>
  Build ServiceAccounts with RBAC, generate kubeconfigs, manage ConfigMaps and
  Secrets, watch live cluster resource usage, and tame Headlamp's sidebar —
  all from a GUI, no <code>kubectl</code> and no YAML hand-editing.
</p>

<p align="center">
  <a href="https://github.com/ja74687/headlamp-click-ops/actions/workflows/ci.yml"><img src="https://github.com/ja74687/headlamp-click-ops/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://buycoffee.to/softime-pk" target="_blank"><img src="https://img.shields.io/badge/%E2%98%95-Postaw%20mi%20kaw%C4%99-FFDD00?style=flat&labelColor=000000" alt="Postaw mi kawę na buycoffee.to" /></a>
</p>

<p align="center">
  <a href="https://buycoffee.to/softime-pk" target="_blank"><img src="https://buycoffee.to/static/img/share/share-button-primary.png" width="254" height="66" alt="Postaw mi kawę na buycoffee.to"></a>
</p>

## What it does

The plugin adds **six pages** to Headlamp's sidebar:

### Access Builder

- Pick scope: namespaced (Role + RoleBinding) or cluster-wide (ClusterRole +
  ClusterRoleBinding), with an explicit warning for the cluster-wide option.
- **Multi-namespace**: select 2+ namespaces and the plugin creates a single
  ClusterRole plus one RoleBinding per namespace, so the account only sees
  the namespaces you picked.
- Build rules from presets (viewer / deployer / pod debugger / cluster viewer
  / cluster admin) or with a manual API-groups × resources × verbs editor.
- Live YAML preview, one-click apply, creates the SA + Role/ClusterRole +
  binding(s) + long-lived token Secret.
- **Headlamp UI access**: a RoleBinding only grants access inside its own
  namespace, even when it points at a ClusterRole — so listing namespaces,
  reading nodes and reading metrics (all cluster-scoped) would fail with
  *namespaces is forbidden ... at the cluster scope* and leave the cluster
  overview empty. Pick a level and the plugin creates a separate
  `<name>-cluster-read` ClusterRole + ClusterRoleBinding next to the account:
  namespace list only (the recommended minimum), plus nodes and metrics, plus
  cluster-wide pods and PVCs, or plus `nodes/proxy` for disk stats. The last
  one is flagged as privilege escalation, because kubelet access leaks logs
  and metadata of pods in namespaces the account was never granted.
- **Access check**: one click runs a set of SubjectAccessReviews against the
  API server and shows, per capability, what the account may actually do —
  so you find out that Headlamp will greet it with *namespaces is forbidden*
  here, rather than from the person you handed the kubeconfig to.
- Auto-detects the API server URL from `kube-public/cluster-info` or the
  `kubernetes` Endpoints.
- Downloads a ready-to-use `.kubeconfig` (CA + token already embedded) — works
  with `kubectl --kubeconfig=...` and with Headlamp's *Add cluster → Load from
  KubeConfig*.
- **Manage view**: lists every account the plugin has created, lets you edit
  rules/namespaces, re-download the kubeconfig, or cascade-delete the whole
  set (SA + Role + bindings + Secret).

- **Diff before save**: editing an account shows exactly what will be created,
  updated, recreated or deleted before anything is applied — deletions being
  the part worth seeing, since dropping a namespace takes that access away.
- **Export / import**: dump every managed account to a YAML file (permissions
  only, never tokens) to keep in git or replay on another cluster.
- **Leftovers**: finds objects the plugin created whose ServiceAccount is
  gone, and removes them in an order that never leaves a binding pointing at
  a deleted role. Worth doing — recreating a ServiceAccount with the same
  name would silently inherit every permission the old one had.
- **Expiring tokens**: issue the kubeconfig from the TokenRequest API with a
  lifetime from one hour to a year, instead of the long-lived Secret token
  that never expires and that nothing revokes if the file leaks.

### Namespace Access

The inverse view: pick a namespace and see everything that grants access to
it, including bindings this plugin never created. Lists the namespace's
RoleBindings plus every ClusterRoleBinding — a ClusterRoleBinding reaches
into every namespace at once, which is the grant people forget when auditing.
Each row says whether the role is read-only, can write, or is a full-access
grant.

### Resource Builder

- **ConfigMaps** — create/edit/delete with a key/value form, YAML preview.
- **Secrets** — create/edit/delete with a type selector (Opaque, TLS,
  basic-auth, Docker registry, SSH), per-row show/hide, auto base64 encoding,
  and *load-from-file* (picks the filename as the key).
- Namespace picker at the top is **synced with Headlamp's global filter** —
  pick here or in the topbar, both stay in sync. Pre-selects that namespace
  when creating a new resource.
- "Hide system" toggle hides noise like `kube-root-ca.crt` and
  service-account-token Secrets.

### Traefik

For clusters running Traefik v3 (`traefik.io/v1alpha1` CRDs — k3s ships it
by default). Traefik v2 (`traefik.containo.us`) is detected and reported, not
supported.

**It checks what your Traefik actually reads before offering anything.**
Middlewares only count when Traefik's `kubernetesCRD` provider is on, the
`router.middlewares` annotation only when its own Ingress provider is, and a
Traefik that replaced ingress-nginx often runs just the ingress-nginx
compatibility provider, which ignores both. The page reads the providers and
the version from the Traefik DaemonSet / Deployment, shows them at the top,
and never lets you attach something nothing enforces — an admin panel that
looks protected but isn't is the failure it is built to prevent. When it
cannot tell (no permission to read workloads, several Traefiks, a config
file), it says "unknown" and asks you to confirm instead of guessing.

**ingress-nginx compatibility mode.** For Ingresses served that way, the
Routes tab shows the protection that really applies, read from the
`nginx.ingress.kubernetes.io/*` annotations — IP allowlist, password, HTTPS
redirect — and marks a missing allowlist or password in red. One click opens
an editor for them:

- **IP allowlist** (`whitelist-source-range` / `allowlist-source-range`),
  validated, with a warning when a change could lock you out.
- **Password**: a username and password become an `$apr1$` htpasswd line in a
  Secret `<ingress>-basic-auth` (the format `openssl passwd -apr1` makes),
  wired up with `auth-type`, `auth-secret` and `auth-realm`. A password set up
  by hand is shown and left alone; switching the password off removes only the
  Secret the plugin created, and not while another Ingress still uses it.
- **Force HTTPS** (`force-ssl-redirect`).
- Removing the allowlist or the password, or adding `0.0.0.0/0`, needs an
  explicit confirmation. Writes carry the Ingress's `resourceVersion`, so a
  change someone made meanwhile is reported, not overwritten.
- Version-aware: the allowlist annotations only exist from Traefik 3.7, so on
  older versions a list is shown as ignored and cannot be edited.

Reading the providers needs cluster-wide `list` on `daemonsets`,
`deployments` and `statefulsets`; without it the page falls back to
"unknown".

- **Middlewares from a form**, no YAML: pick a card and fill in the blanks.
  - **IP allowlist** — addresses and CIDR networks, one-click private
    ranges and localhost, an option for Traefik behind a load balancer
    (`ipStrategy.depth`), custom reject status.
  - **Login (basic auth)** — username and password; the plugin creates the
    `kubernetes.io/basic-auth` Secret the middleware reads. One middleware
    holds one user, and the password sits in the Secret as base64, so
    whoever can read Secrets in that namespace can read it.
  - **Redirect to HTTPS**, **security headers** (HSTS, frame deny,
    nosniff, referrer policy, custom headers), **rate limit**, **strip
    path prefix**.
- Editing an existing middleware keeps every field the form does not show,
  and only middlewares the form fully understands can be edited — chains,
  forwardAuth and the like are listed read-only.
- **Routes** tab: tick middlewares on an Ingress (written to the
  `traefik.ingress.kubernetes.io/router.middlewares` annotation) or on each
  route of an IngressRoute. References the dialog does not manage —
  `@file` providers, other namespaces — stay where they were. Each Ingress
  shows which Traefik provider serves it (native, ingress-nginx
  compatibility, none, or unknown), and the middleware editor is only
  offered where the native provider and the CRD provider will read it.
- **Access logs per route**: default / on / off, through the
  `router.observability.accesslogs` annotation or `routes[].observability`.
  This only has an effect when access logging is enabled in Traefik's static
  configuration (Helm values); if the installed CRDs are too old to know the
  field, the page says so instead of reporting success.
- Middleware lists show what uses each one, and deleting asks with that list
  in front of you.

### Cluster Monitor

- Three summary cards: total cluster CPU, memory and disk (root fs) — fed by
  metrics-server (CPU/RAM) and kubelet stats (disk).
- Per-node table with progress bars for CPU, memory, root FS and image FS —
  the latter is what fills up first on busy nodes.
- **Top pods by CPU** and **top pods by memory** side by side (top 5 of all
  pods, cluster-wide).
- **PersistentVolumeClaims** list with per-PVC capacity and live usage. Usage
  comes from the kubelet `pods[].volume[]` stats; CSI drivers like OpenEBS or
  Longhorn report it. The microk8s in-tree hostpath provisioner doesn't, so
  capacity-only is shown there with a note.
- Auto-refresh every 15 seconds plus a manual refresh button. Graceful
  fallback when metrics-server isn't installed or `nodes/proxy` RBAC is
  missing — affected sections show a one-line warning instead of crashing.

### Sidebar Settings

- Walks Headlamp's sidebar tree and lists **every** entry — built-in
  categories (Workloads, Storage, Network, Security, Configuration, Custom
  Resources, Apps, Gateway), every CRD group registered in the cluster, and
  plugin-added entries — in a single hierarchical table.
- **Hide / restore** any entry with one click; a hidden entry vanishes from
  the sidebar instantly (no Headlamp restart) and reappears just as fast when
  you un-tick it here.
- Hierarchy is reconstructed from three sources stacked together: a known
  mapping of Headlamp's top-level categories (Pods → Workloads, PVCs →
  Storage…), URL-prefix matching (`/apps/catalog` under `/apps`), and the
  CRD `group-<group>` / `<plural>.<group>` naming convention — so things
  end up where you'd expect.
- **Smart cascade**: tick a parent and all its children get hidden; un-tick
  one child while the parent is hidden and the parent restores itself; hide
  the last visible child of a category and the parent goes too. No stranded
  half-hidden categories.
- The Sidebar Settings entry itself is the one safe item — it never appears
  in the table and can never be hidden, so you can always get back here.

> ⚠️ Headlamp's plugin filter API in 0.41 only supports show/hide (not
> reparenting), so a collapsible *More* submenu isn't possible from a plugin
> alone — hidden = hidden, restored from this page.

## Compatibility

- Headlamp **0.41+** (desktop app recommended — tested there)
- Plugin SDK `@kinvolk/headlamp-plugin` **0.13.x**

## Installation (Headlamp desktop)

### Option A — download a release

1. Go to the [Releases](https://github.com/ja74687/headlamp-click-ops/releases)
   page and download the latest `headlamp-click-ops-vX.Y.Z.zip`.
2. Extract it into Headlamp's plugins directory:
   - **Windows**: `%APPDATA%\Headlamp\Config\plugins\`
   - **macOS**: `~/Library/Application Support/Headlamp/Config/plugins/`
   - **Linux**: `~/.config/Headlamp/Config/plugins/`

   Final layout:

   ```
   plugins/headlamp-click-ops/
     main.js
     package.json
   ```
3. **Fully quit Headlamp** (check the system tray, not just the window) and
   start it again. Six new entries — *Access Builder*, *Namespace Access*,
   *Resource Builder*, *Traefik*, *Cluster Monitor* and *Sidebar Settings* —
   show up in the sidebar once you open a cluster.

### Option B — build from source

```bash
git clone https://github.com/ja74687/headlamp-click-ops.git
cd headlamp-click-ops
npm install
npm run build
```

Then copy `dist/main.js` and `package.json` to the plugins directory as in
Option A, into a folder named `headlamp-click-ops/`.

Windows one-liner for re-installing after a rebuild (PowerShell):

```powershell
Copy-Item dist\main.js,package.json "$env:APPDATA\Headlamp\Config\plugins\headlamp-click-ops\" -Force
```

### Note about `package.json`

Headlamp reads `devDependencies["@kinvolk/headlamp-plugin"]` from the plugin's
`package.json` to verify SDK compatibility. If you only copy `main.js` (no
`package.json`) the plugin will appear as *"Incompatible plugin disabled"*.
Always copy both.

## Development

```bash
npm install
npm start       # watch-mode build
npm run tsc     # type-check
npm run lint    # eslint
npm run build   # production bundle → dist/main.js
```

Start Headlamp desktop in parallel; it picks up changes from the installed
plugin directory on save.

## How RBAC pieces fit together

If you're new to Kubernetes RBAC, the cheat sheet the plugin follows:

- **ServiceAccount** — the identity (just a name).
- **token Secret** — the password for that identity. Kubectl puts this in the
  `Authorization: Bearer ...` header on every call.
- **Role / ClusterRole** — the *job description*: "on resources X you may do
  verbs Y". Role is namespaced, ClusterRole is global.
- **RoleBinding / ClusterRoleBinding** — the contract: "this SA holds this
  role in this scope".

For multi-namespace access, the plugin uses the standard Kubernetes trick:
one ClusterRole + N RoleBindings (one per namespace). That way the account
sees exactly those N namespaces, not the whole cluster.

The catch worth knowing: **a RoleBinding never grants anything cluster-scoped**,
even when its `roleRef` is a ClusterRole. Rules about `namespaces`, `nodes` or
`metrics.k8s.io` sitting in that ClusterRole are simply dead. Anything the user
needs cluster-wide has to come from a real ClusterRoleBinding — which is exactly
what the *Headlamp UI access* option creates. Without it the account works fine
with `kubectl -n <namespace>` but Headlamp cannot even list namespaces.

If you would rather not grant a cluster-wide namespace list at all, set
*Allowed namespaces* in Headlamp's cluster settings instead and leave UI access
at *None*.

## Releasing a new version (maintainer)

The `.github/workflows/release.yml` workflow builds the plugin and publishes
both a `.tar.gz` (for the Headlamp Plugin Catalog via ArtifactHub) and a
`.zip` (for manual install) to a GitHub Release whenever you push a tag
matching `v*`:

```bash
# bump version in package.json first
git tag vX.Y.Z
git push origin vX.Y.Z
```

The workflow does: `npm install` → `npm run build` → `npm run package`
(produces tarball + sha256) → updates `artifacthub-pkg.yml` on `main` with
the new version, archive URL and checksum (committed back automatically) →
creates a GitHub Release with both archives attached. ArtifactHub picks up
the new version on its next scan (~30 min) and the Headlamp Plugin Catalog
shows an *Update* button to existing users.

## Support the project

<a href="https://buycoffee.to/softime-pk" target="_blank"><img src="https://buycoffee.to/static/img/share/share-button-primary.png" style="width: 254px; height: 66px" alt="Postaw mi kawę na buycoffee.to"></a>

## License

[MIT](./LICENSE) — do what you want, just don't blame me.
