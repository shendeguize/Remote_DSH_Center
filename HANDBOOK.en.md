# DSH Center Handbook

[中文](HANDBOOK.md) · **English** · [Back to README](README.en.md)

This handbook carries the complete usage and maintenance details that do not belong on the
README front page. For a first run, start with the
[README quick start](README.en.md#five-minute-quick-start).

## Requirements and local/remote differences

| | Complete requirements |
|---|---|
| Manager machine | macOS or Linux. A source / git install needs **Node ≥ 22**; macOS may use a standalone bundle with its own official Node runtime |
| Managed local machine | A local DeepSeek Harness (`dsh`) installation and configured web profile are needed only if you choose to manage this machine |
| Managed remote | `dsh` installed with a web profile configured. Center probes only; it does not install or configure `dsh` |
| SSH | Remote candidates come from `~/.ssh/config`, should allow key-based login, and must not disable `AllowTcpForwarding` |

### Platform support matrix

| Platform | Install and release commitment | Verification |
|---|---|---|
| macOS arm64 (Apple Silicon) | First-class: source / git installs and a standalone Release bundle | The matching bundle is built and verified on real hardware |
| macOS x64 (Intel) | First-class: source / git installs and a standalone Release bundle | The matching bundle is built and verified on real hardware |
| Linux | Best-effort source / git installation and foreground operation; no release bundle; `dshc service` is unavailable because it requires macOS launchd | Project gates run in Ubuntu CI |

**Node 22** is the tested minimum for source / git installations. Any increase to that
minimum is announced in the [CHANGELOG](CHANGELOG.md) and the corresponding release notes.

Managing the local machine is optional. Setup offers one built-in local candidate that you may
leave unselected, and a manager may contain at most one `local:true` entry. An SSH host is never
guessed to be local just because it is named `localhost` or `127.0.0.1`.

The two host types use different transports:

- **Local:** protocol scripts run through the local shell. The browser connects directly to that
  run's actual loopback port, with no `ssh -L`, and the host never enters `degraded`.
- **Remote:** control actions are one-shot SSH commands. The page reaches a local loopback mapping
  through `ssh -L`. There is no Center agent or daemon on the host.

For both transports, Center-managed logs, patches, settings staging, and backups stay under the
target account's `~/.dsh_center_remote/`. The one exception is an explicit user save to the
resolved `${DSH_HOME:-$HOME/.dsh}/settings.yaml`.

If a target lacks `dsh` or its web profile, probing labels it "not installed / not configured"
instead of pretending it is usable. Center never installs it.

## Installation

### One command and automatic channel selection

```bash
curl -fsSL https://raw.githubusercontent.com/shendeguize/Remote_DSH_Center/main/install.sh | bash
```

The bootstrap works whether or not Node is installed, then chooses:

| Channel | Selected when | What is installed |
|---|---|---|
| **git** | Node ≥ 22 is available (default) | Clone of the `release` branch under `~/.dsh_center/app`; `dshc` symlinks to `src/cli.js` |
| **standalone** | Node is absent or too old; automatic fallback on macOS only | Matching Release bundle, SHA256-verified before unpacking; it carries official Node and `dshc` symlinks to its launcher |

Standalone uses only the Node inside its bundle and does not touch Node on the machine. There are
no Linux standalone bundles, so Linux needs Node ≥ 22. Both channels delegate symlinking,
conflict classification, and PATH hints to `scripts/install.mjs`.

### Verify a manually downloaded bundle

If you download a `.tar.gz` manually from a GitHub Release, check `SHA256SUMS`, then use GitHub
CLI to verify the bundle's build-provenance attestation:

```bash
gh attestation verify ./dsh-center-v0.2.0-darwin-arm64.tar.gz --repo shendeguize/Remote_DSH_Center
```

### Choose a channel or version

```bash
curl -fsSL <the URL above> | bash -s -- --standalone         # force standalone
curl -fsSL <the URL above> | bash -s -- --git                # force git; fail if Node is missing
curl -fsSL <the URL above> | bash -s -- --pre                # allow pre-release versions
curl -fsSL <the URL above> | bash -s -- --version v0.1.0     # pin a Release for standalone
curl -fsSL <the URL above> | DSHC_REF=main bash              # check out main for this install only
curl -fsSL <the URL above> | DSHC_REF=v0.1.0 bash            # check out this tag for this install only
```

`DSHC_REF` selects only this installation's git checkout; it does not persist an update policy.
A later plain `dshc update` defaults back to `release`. To keep using main or a particular tag,
run `dshc update --ref main` / `dshc update --ref <tag>` explicitly, or set `DSHC_REF` again
when rerunning the installer.

Flags passed through a pipe require `bash -s --`:

```bash
curl -fsSL <the URL above> | bash -s -- --service               # also install launchd autostart
curl -fsSL <the URL above> | bash -s -- --prefix /usr/local/bin # choose the dshc symlink directory
```

For a fully manual installation:

```bash
git clone -b release https://github.com/shendeguize/Remote_DSH_Center.git ~/.dsh_center/app
cd ~/.dsh_center/app && npm run install:cli
```

Run `dshc version` afterward to see the version, installation channel, active Node, and install
directory. You can also skip installing the CLI and run `node src/cli.js <command>` from a clone.
See [install.sh](install.sh) for the bootstrap details.

## First start

```bash
dshc init
dshc up
dshc open
```

`dshc init` is a four-step wizard:

1. Choose the manager port and remote mapped-port range.
2. Set the agreed `dsh web` port.
3. Select managed hosts from the built-in local candidate and `~/.ssh/config` remotes.
4. Preview and confirm the configuration.

Step 3 probes each candidate; a slow host does not block selection. Only a `ready` probe result
may enable autostart. An unprobed or unavailable host may still be managed, but it cannot
autostart. An unselected local candidate is not written to config.

## Everyday entry points

- `#/hub` is the default entry. The `#/` root restores the last host only while it remains
  openable; otherwise it enters the Hub. Clicking the brand always returns explicitly to Hub.
- Enabled `ready / starting / running / degraded / crashed` hosts stay in the top bar. Clicking a
  `ready` tab or Hub card performs "start and enter," with an overlay showing progress.
- Switching iframe views changes visibility without reloading, preserving in-page session state.
- `#/manage` is the secondary administration page for the host table, probe-all, configuration
  reload, global defaults, events, and host details. A host menu can open its mapped URL in a new
  window.
- A local host has no tunnel to reconnect, so the UI hides or refuses meaningless reconnect
  actions.

Closing a browser tab does not stop any `dsh web`. Instances and remote tunnels belong to the
manager, not the browser lifecycle.

## States and self-healing

Each host moves through eight phases:

```text
unknown → unreachable / no_dsh / ready          (three probe outcomes)
ready   → starting → running                    (start)
running → degraded → running                    (remote tunnel drops and recovers)
running → crashed → starting → running          (manual restart after process death)
```

- A remote tunnel drop becomes `degraded` and reconnects with 1/2/4/8/16/30-second backoff. If
  forwarding is explicitly forbidden (`AllowTcpForwarding=no`), retries suspend instead of
  looping pointlessly.
- Every 30 seconds, a sweep first sends a minimal HTTP request through the local mapping and
  **requires bytes back**. A TCP connect alone gives false health because SSH may keep accepting
  after the remote process dies. On failure, a deep SSH verification distinguishes a genuinely
  dead process (`crashed`) from a live process that only needs a fresh tunnel child.
- A manager restart **does not relaunch managed processes**. It verifies fingerprints and adopts
  surviving instances, rebuilding remote tunnels or re-registering local direct connections.
- Local hosts reuse HTTP probing and fingerprint verification but have no transport to rebuild.
  A dead process becomes `crashed`; a matching live process with a temporarily unresponsive port
  stays `running` for another sweep instead of inventing `degraded`.

## Configuration and data

Every runtime parameter comes from `~/.dsh_center/config.json`. `DSHC_HOME` relocates the whole
directory; the code contains only one factory-default table, `src/defaults.js`.

```text
~/.dsh_center/
  config.json    # only config source: manager, agreed ports, mapped range, per-host transport/switches/injection
  state.json     # pid, port, fingerprint, tunnel/direct connection, patch records; safe to delete
  manager.log    # event log; long SSH stderr and similar text uses indented continuation lines
  manager.pid
  app/           # code installed by the one-click script; a manual clone may live elsewhere
```

Each host has an optional `local` identity. Older configs without it are treated as `false` (SSH)
and do not need setup again. A local entry requires `localPort: null`, and there may be at most
one. It uses the actual web port and does not consume the remote mapped-port pool.

The factory-agreed `dsh web` port is 8899. If occupied, the launcher falls back to `--port 0` and
lets the target OS assign one. A remote then gets a stable local mapping from the configured
range; a local host uses the actual port directly.

Host-level settings and injection take effect on the **next start** and never modify a running
instance. Changing `manager.port` only writes config; `dshc restart` is required to move the
listener.

### Launch directory and dsh Workspace

`hosts.<host>.workdir` sets the target `dsh web` process working directory. It is also the
fallback for a new session with no explicit Workspace/cwd and the location from which
`AGENTS.md` is loaded:

```bash
dshc config set hosts.gpu-1.workdir '~/projects/foo'
```

An empty string or `null` clears it to the target account's home. Only an absolute path, `~`, or
`~/…` is accepted; that account expands `~`. If the directory cannot be entered, start fails
loudly instead of silently falling back to home.

A workdir is not automatically registered as a dsh Web Workspace and does not replace a
historical session restored by the browser. Once the directory is active and the instance is
connected, use **Register launch directory as Workspace** in the host detail's **dsh Workspace**
section. Center calls dsh Web's official `workspace.create` API through the local mapping.
Repeated registration is idempotent and does not modify the remote dsh CLI or `HOME`. dsh Web's
own directory picker still starts from the target account's `HOME` under its upstream rules.

Saving workdir never disturbs the current instance. Restart that host's `dsh web`; restarting
only the manager does not change the working directory of a surviving process.

### Editing the dsh configuration file

An `ssh -L` mapping brings a page to the local browser, not the remote desktop capability. The
remote dsh Web "Open configuration file" action still calls a desktop opener on the target.
For a headless Linux host, use the **dsh configuration file** section in host details to read and
edit `${DSH_HOME:-$HOME/.dsh}/settings.yaml` over SSH. A local entry uses the equivalent local
transport.

Center treats the file as opaque UTF-8 and never parses or rewrites YAML, avoiding dependence on
dsh's current schema. The body flows only through one-shot command stdin/stdout: reads return
reversible hex over stdout, and saves send the body over stdin. Reads and writes are each limited
to 512 KiB. Before save, a checksum detects another editor's changes; Center then makes a backup
and atomically replaces the file.
On conflict or an unknown save result, the page asks for a reload and preserves the old draft
for manual merging. dsh watches and reloads this file itself; Center does not modify the dsh CLI
or restart the instance.

## Security boundary

This tool is designed as a **single-user desktop tool on a trusted network**:

- The manager binds `127.0.0.1` and has **no authentication**. Anything that can run code locally
  can drive it, including the managed local instance and remotes reached through tunnels.
  **Never bind it to `0.0.0.0` or forward its port to the public internet.**
- Loopback binding does not stop a browser from making requests for someone else. A request with
  `Origin` must use the manager's own origin, and `Host` must be a loopback name. The latter
  blocks an attacker domain resolving to `127.0.0.1` and placing the page in its origin. The CLI
  sends no `Origin` and is unaffected.
- The remote data plane is `ssh -L`; encryption and authentication come from SSH configuration
  and keys. The local data plane connects directly to loopback.
- A dsh configuration file may contain credentials. Its body exists briefly in manager/browser
  memory and one-shot command stdin/stdout (reads use reversible hex), and is never written to
  manager config, logs, or SSE. Do not share the manager page or browser session with untrusted
  users.
- Apart from an explicit **Save file** action, managed-side artifacts stay under
  `~/.dsh_center_remote/` in that account's HOME (logs, patches, settings staging, and one
  backup). Explicit save may write only the resolved
  `${DSH_HOME:-$HOME/.dsh}/settings.yaml`; the API accepts no arbitrary path. **Local** patch
  sync shares `patches/` with user files and refuses to remove an existing file whose ownership
  it cannot prove. The remote `~/.dsh_center_remote/patches/` is Center-managed, so remote sync
  removes files no longer referenced by configuration. Both patch destinations remain confined
  to that managed directory.
- Injected environment variables and extra arguments appear verbatim on the target command line
  and are visible to `ps`; **never put secrets there**.
- **Never killing the wrong process is a hard boundary.** Before local or remote stop, Center
  compares the recorded `ps` command-line fingerprint verbatim. Manual instances are read-only,
  and a mismatch refuses the kill. The worst case is failing to stop the intended process, not
  stopping somebody else's.

## Command quick reference

```text
Lifecycle: dshc init / up / down / restart / status / logs / service install|uninstall|status
Itself:    dshc version / update      # version --json; update --pre / --ref <branch|tag> / --restart
Hosts:     dshc ls / probe / start / stop / reconnect / log / open / config
Exit codes: 0 success | 1 operation failed | 2 timeout/communication failure | 3 usage error | 130 Ctrl-C interrupted the wait (operation continues)
```

`dshc --help` prints complete usage. `DSHC_SSH_CONFIG` selects a different SSH config.
`dshc service install` writes a launchd plist whose KeepAlive restarts a killed manager. Linux
does not support that command; write a systemd unit targeting `dshc up --foreground`.

## FAQ

**Does it work on Linux?** Source / git installation and foreground operation are supported
on a best-effort basis, with project gates running in Ubuntu CI. There is no Linux release
bundle. `dshc service` is unavailable because it requires macOS launchd; for autostart,
write a systemd unit pointing at `dshc up --foreground`.

**What if a local or remote target has no dsh?** Probe labels it "not installed / not configured"
and distinguishes a missing binary from a missing web profile. It installs nothing and will not
allow an accidental start.

**Will it stop a `dsh web` that someone started manually?** No. Manual instances are shown as
"🔒 manual" and read-only; `stop` and `restart` are refused. A fingerprint mismatch never kills.

**Can the remote's `X-Frame-Options` block the iframe?** In practice, dsh web sets no such header.
The initial loading state only means waiting and cannot diagnose a cross-origin failure. If
embedding is blocked, use **Open in a new window** from the host menu.

**Must the manager restart after a config change?** Host-level settings apply on next start.
Changing `manager.port` requires `dshc restart`, and the page says so explicitly.

**Does closing the browser stop an instance?** No. Stop explicitly with `dshc stop <host>`.
`dshc down` closes only the manager and transport resources; it **does not stop managed
`dsh web` processes as a side effect**.

## Upgrading

Re-running the one-click installer upgrades in place, or use:

```bash
dshc update              # update to the latest stable release on the installation channel
dshc update --pre        # allow a pre-release version
dshc update --restart    # restart the manager afterward; default is only a reminder
```

- For a **git install**, plain `dshc update` defaults to `origin/release`. Only an explicit
  `dshc update --ref main` / `--ref <tag>` selects another target, for that update only. Updates
  are fast-forward only: a dirty working tree or a target that is not a descendant is refused,
  and local changes are never overwritten by a merge. Example rollback:
  `git -C ~/.dsh_center/app checkout v0.1.0`.
- A **standalone install** writes only after SHA256 verification, switching with "unpack to
  `.new` → atomic rename." The previous release remains at `~/.dsh_center/app.prev` and can be
  moved back.

See [CHANGELOG.md](CHANGELOG.md) for release changes.

## Full uninstallation

First stop the service and manager in this safe order:

```bash
dshc service uninstall  # 1. if launchd autostart was installed
dshc down               # 2. stop the manager and tunnels
```

Then invoke the installed channel's own uninstaller to remove the link; choose one:

```bash
# Default git path: use the system Node
node ~/.dsh_center/app/scripts/install.mjs --uninstall

# Default standalone path: use the bundled Node
~/.dsh_center/app/runtime/bin/node \
  ~/.dsh_center/app/app/scripts/install.mjs --uninstall
```

If installation used a custom `--prefix`, pass the same `--prefix` during uninstall. If the app
root was customized, replace the script and bundled-Node paths accordingly. Do not blindly `rm`
the link instead of using the installer. After unlinking, remove manager data:

```bash
rm -rf ~/.dsh_center
```

Removing manager data does not remove managed-side directories. Local logs and patches may
remain in `~/.dsh_center_remote/`, and remotes are the same. Confirm that relevant instances have
stopped, then clean each host:

```bash
rm -rf ~/.dsh_center_remote
ssh <host> 'rm -rf ~/.dsh_center_remote'
```

If `dsh web` is still running, stop it from the management page or with `dshc stop <host>`.
The last-resort `ssh <host> 'pkill -f "dsh web"'` **does no fingerprint verification and will
also kill other people's matching instances**. It is substantially riskier than `dshc stop`;
use it with extreme care.

## Architecture details

```mermaid
flowchart LR
    subgraph Local
        B[Browser<br/>Hub + iframes] -->|REST + SSE| M[manager<br/>127.0.0.1:7788]
        C[dshc CLI] -->|same REST API| M
        M -->|one-shot local shell| L[Local dsh web<br/>actual port]
        B -.->|direct loopback| L
        M --> T[ssh -L child]
        B -.->|mapped port| T
    end
    subgraph Remote
        M -->|one-shot SSH control| R[Remote dsh web<br/>127.0.0.1:8899]
        T ==>|encrypted tunnel| R
    end
```

- **The manager is the single source of truth.** An iframe uses the `mappedUrl` returned by the
  manager; the frontend neither copies default ports nor guesses runtime parameters.
- **Control and data planes are separate.** Control is REST/SSE followed by the same protocol
  through local shell or one-shot SSH. The browser connects pages, assets, and WebSockets
  directly to the actual or mapped port; the manager does not proxy data.
- **Only SSE advances state.** Buttons do not optimistically mutate phases; the UI waits for
  `host-changed` and `operation-done`.
- **Remote compatibility is end to end.** Probe, launch, sweep, fingerprint verification, stop,
  and logs all use one-shot protocol commands, with nothing installed or kept resident.

## Development and real-machine acceptance

Runtime and tests have zero npm dependencies, so there is no `npm install` step.

```bash
npm run check                    # complete gate
npm run check -- --only tests    # select gates; also --skip ui / --require-browser / --list
npm test                         # unit, fake-remote integration, CLI e2e, frontend, tooling, install.sh
npm run coverage                 # coverage report
npm run coverage:gate            # overall and tiered coverage gate
npm run matrix:gate              # behavior inventory vs coverage matrix; -- --suggest lists candidate tests
npm run perf:gate                # wall-clock baseline (soft gate); -- --record re-records, -- --advisory warns only
npm run mutation:gate            # mutation testing (weekly gate); -- --tier lib --only shq.js for a fast single file, -- --list to preview
npm run ui:smoke                 # real-browser smoke in headless Chrome
```

Site and demo:

```bash
npm run site:dev      # build _site/ and serve it at http://127.0.0.1:4321
npm run site:build    # build only; _site/ is not committed
npm run site:shots    # generate the interface shots used by README and landing
npm run site:check    # site build, demo smoke, bilingual README links and commands
```

The live demo has `site/demo/demo-shim.js` override `window.fetch` and `window.EventSource` and
route them to an in-browser fake manager; state transitions reuse `src/lib/machine.js`.
`src/web/**` has no demo-specific modification, so drift makes the check fail directly.

Tests never touch real machines. `tests/harness/` supplies fake SSH/SCP, local-shell and dsh-web
shims, a state engine, 15 remote fault scenarios, and the full local flow. Real-machine
acceptance is an explicit operator action:

```bash
npm run acceptance:real -- --host <ssh-host>                        # IT-01…13
npm run acceptance:real -- --host <ssh-host> --only IT-06,IT-09 --keep
```

CI runs required `npm run check` on Ubuntu for pull requests and repeats it on macOS after a
merge to main. Ubuntu includes Chrome, so the browser gate must run. macOS may skip it when
Chrome is absent; use `DSHC_CHROME=<path>` to select a browser locally.

Code map: `src/lib/` is the pure kernel; `src/*.js` is the
store/ports/prober/launcher/tunnel/monitor/API/server/CLI/daemon module layer; `src/web/` is the
native ESM frontend; and `site/` is the landing page plus live demo. See
[tests/COVERAGE_MATRIX.md](tests/COVERAGE_MATRIX.md) for coverage ownership,
[CONTRIBUTING.md](CONTRIBUTING.md) for collaboration and release rules, and
[AGENTS.md](AGENTS.md) for hard constraints before changing code.
