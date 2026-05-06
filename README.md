<p align="center">
  <img src="assets/logo/icon.svg" alt="headlamp-click-ops" width="160" height="160" />
</p>

<h1 align="center">headlamp-click-ops</h1>

<p align="center">
  Point-and-click cluster ops for <a href="https://headlamp.dev">Headlamp</a>.<br/>
  Build ServiceAccounts with RBAC, generate kubeconfigs, manage ConfigMaps and
  Secrets, and watch live cluster resource usage — all from a GUI, no
  <code>kubectl</code> and no YAML hand-editing.
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

The plugin adds **three pages** to Headlamp's sidebar:

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
- Auto-detects the API server URL from `kube-public/cluster-info` or the
  `kubernetes` Endpoints.
- Downloads a ready-to-use `.kubeconfig` (CA + token already embedded) — works
  with `kubectl --kubeconfig=...` and with Headlamp's *Add cluster → Load from
  KubeConfig*.
- **Manage view**: lists every account the plugin has created, lets you edit
  rules/namespaces, re-download the kubeconfig, or cascade-delete the whole
  set (SA + Role + bindings + Secret).

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
   start it again. Two new entries — *Access Builder* and *Resource Builder* —
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

## Releasing a new version (maintainer)

The `.github/workflows/release.yml` workflow builds the plugin and attaches a
zip to a GitHub Release whenever you push a tag matching `v*`:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The workflow then does: `npm install` → `npm run build` → zip `main.js +
package.json` as `headlamp-click-ops-v0.2.0.zip` → create a GitHub Release and
upload the zip as an asset.

## Support the project

<a href="https://buycoffee.to/softime-pk" target="_blank"><img src="https://buycoffee.to/static/img/share/share-button-primary.png" style="width: 254px; height: 66px" alt="Postaw mi kawę na buycoffee.to"></a>

## License

[MIT](./LICENSE) — do what you want, just don't blame me.
