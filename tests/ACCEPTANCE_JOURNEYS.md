# 可执行用户旅程清单

> 本文件由 `scripts/acceptance-journeys.mjs` 生成，请勿手工编辑。

## center-first-run：首次配置与 manager 生命周期

- tier: `local`

| 步骤 | 命令 | 期望 | 行为绑定 |
|---|---|---|---|
| help | `node src/cli.js --help` | `{"code":0,"stdout":"dshc"}` | `CLI:up`、`CLI_EXIT:0` |
| version | `node src/cli.js version --json` | `{"code":0,"stdout":"version"}` | `CLI:version`、`CLI_EXIT:0` |
| status | `node src/cli.js status --json` | `{"code":0,"stdout":"running"}` | `CLI:status`、`API:GET /api/manager/info` |

## remote-host-closed-loop：远端主机探测、拉起、页面可达、关停

- tier: `real`

| 步骤 | 命令 | 期望 | 行为绑定 |
|---|---|---|---|
| probe | `dshc probe ${host}` | `{"code":0}` | `CLI:probe`、`API:POST /api/hosts/probe`、`API:POST /api/hosts/:name/probe`、`FSM:unknown→ready` |
| start | `dshc start ${host}` | `{"code":0,"phase":"running"}` | `CLI:start`、`API:POST /api/hosts/:name/start`、`FSM:ready→starting`、`FSM:starting→running` |
| open | `dshc open ${host}` | `{"code":0,"mappedUrl":true}` | `CLI:open`、`API:GET /api/hosts` |
| stop | `dshc stop ${host}` | `{"code":0,"phase":"ready"}` | `CLI:stop`、`API:POST /api/hosts/:name/stop`、`FSM:running→ready` |

## remote-resilience：远端崩溃、隧道自愈与 manager 恢复

- tier: `real`

| 步骤 | 命令 | 期望 | 行为绑定 |
|---|---|---|---|
| reconnect | `dshc reconnect ${host}` | `{"code":0,"phase":"running"}` | `CLI:reconnect`、`API:POST /api/hosts/:name/reconnect`、`FSM:degraded→running` |
| restart | `dshc restart ${host}` | `{"code":0,"phase":"running"}` | `CLI:restart`、`API:POST /api/hosts/:name/restart` |
| manager-restart | `dshc restart` | `{"code":0}` | `CLI:restart`、`API:POST /api/manager/restart` |
| log | `dshc log ${host} -n 20` | `{"code":0}` | `CLI:log`、`API:GET /api/hosts/:name/log` |

## configuration-and-safety：配置同步、settings CAS 与不误杀边界

- tier: `harness`

| 步骤 | 命令 | 期望 | 行为绑定 |
|---|---|---|---|
| get-config | `dshc config get` | `{"code":0}` | `CLI:config`、`API:GET /api/config` |
| set-config | `dshc config set hosts.${host}.workdir ~/workspace` | `{"code":0}` | `CLI:config`、`API:PUT /api/hosts/:name/config` |
| settings-read | `GET /api/hosts/${host}/dsh-settings` | `{"status":200}` | `API:GET /api/hosts/:name/dsh-settings` |
| settings-write | `PUT /api/hosts/${host}/dsh-settings` | `{"status":200}` | `API:PUT /api/hosts/:name/dsh-settings` |
| fingerprint-refusal | `harness stop-with-mismatched-fingerprint` | `{"error":"KILL_REFUSED"}` | `ERR:KILL_REFUSED`、`FSM:running→ready` |

## management-and-reload：主机清单、批量同步、reload 与事件流

- tier: `integration`

| 步骤 | 命令 | 期望 | 行为绑定 |
|---|---|---|---|
| list | `dshc ls --json` | `{"code":0,"json":true}` | `CLI:ls`、`API:GET /api/hosts` |
| events | `GET /api/events` | `{"event":"snapshot"}` | `API:GET /api/events` |
| sync-preview | `POST /api/hosts/sync-config {"dryRun":true}` | `{"status":200,"previewToken":true}` | `API:POST /api/hosts/sync-config` |
| reload | `POST /api/reload` | `{"status":200}` | `API:POST /api/reload` |

## safe-failure-surfaces：不可达、非法输入、端口与 setup gate

- tier: `harness`

| 步骤 | 命令 | 期望 | 行为绑定 |
|---|---|---|---|
| bad-host | `dshc start missing-host` | `{"code":3}` | `CLI:start`、`CLI_EXIT:3`、`ERR:NOT_FOUND` |
| unreachable | `dshc start ${unreachableHost}` | `{"code":1}` | `CLI_EXIT:1`、`ERR:SSH_UNREACHABLE`、`FSM:ready→unreachable` |
| timeout | `harness ssh-timeout` | `{"error":"SSH_TIMEOUT"}` | `ERR:SSH_TIMEOUT`、`CLI_EXIT:2` |
| port-exhausted | `harness port-exhausted` | `{"error":"PORT_EXHAUSTED"}` | `ERR:PORT_EXHAUSTED` |
| origin-fence | `harness wrong-origin` | `{"status":403}` | `ERR:FORBIDDEN_ORIGIN`、`ERR:FORBIDDEN_HOST` |

## 矩阵锚点

| 功能章节 | 旅程 |
|---|---|
| §1 | `JOURNEY:center-first-run` |
| §2 | `JOURNEY:remote-host-closed-loop` |
| §3 | `JOURNEY:remote-resilience` |
| §4 | `JOURNEY:configuration-and-safety` |
| §5 | `JOURNEY:management-and-reload` |
| §6–§8 | `JOURNEY:safe-failure-surfaces` |