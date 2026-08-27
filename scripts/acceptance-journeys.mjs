/**
 * 用户旅程可执行规格（本文件是旅程真源）。
 *
 * 规格只描述命令、期望和行为绑定，不执行副作用；journey-gate.mjs 负责静态
 * 对账，journey-runner.mjs/real-acceptance.mjs 负责在明确环境中执行。这样
 * markdown 可以生成而不是另行维护。
 */

const step = (id, command, expect, behaviorIds) => Object.freeze({
  id, command: Object.freeze(command), expect: Object.freeze(expect), behaviorIds: Object.freeze(behaviorIds),
});

export const JOURNEYS = Object.freeze([
  Object.freeze({
    id: 'center-first-run',
    title: '首次配置与 manager 生命周期',
    tier: 'local',
    steps: Object.freeze([
      step('help', ['node', 'src/cli.js', '--help'], { code: 0, stdout: 'dshc' }, ['CLI:up', 'CLI_EXIT:0']),
      step('version', ['node', 'src/cli.js', 'version', '--json'], { code: 0, stdout: 'version' }, ['CLI:version', 'CLI_EXIT:0']),
      step('status', ['node', 'src/cli.js', 'status', '--json'], { code: 0, stdout: 'running' }, ['CLI:status', 'API:GET /api/manager/info']),
    ]),
  }),
  Object.freeze({
    id: 'remote-host-closed-loop',
    title: '远端主机探测、拉起、页面可达、关停',
    tier: 'real',
    steps: Object.freeze([
      step('probe', ['dshc', 'probe', '${host}'], { code: 0 }, ['CLI:probe', 'API:POST /api/hosts/probe', 'API:POST /api/hosts/:name/probe', 'FSM:unknown→ready']),
      step('start', ['dshc', 'start', '${host}'], { code: 0, phase: 'running' }, ['CLI:start', 'API:POST /api/hosts/:name/start', 'FSM:ready→starting', 'FSM:starting→running']),
      step('open', ['dshc', 'open', '${host}'], { code: 0, mappedUrl: true }, ['CLI:open', 'API:GET /api/hosts']),
      step('stop', ['dshc', 'stop', '${host}'], { code: 0, phase: 'ready' }, ['CLI:stop', 'API:POST /api/hosts/:name/stop', 'FSM:running→ready']),
    ]),
  }),
  Object.freeze({
    id: 'remote-resilience',
    title: '远端崩溃、隧道自愈与 manager 恢复',
    tier: 'real',
    steps: Object.freeze([
      step('reconnect', ['dshc', 'reconnect', '${host}'], { code: 0, phase: 'running' }, ['CLI:reconnect', 'API:POST /api/hosts/:name/reconnect', 'FSM:degraded→running']),
      step('restart', ['dshc', 'restart', '${host}'], { code: 0, phase: 'running' }, ['CLI:restart', 'API:POST /api/hosts/:name/restart']),
      step('manager-restart', ['dshc', 'restart'], { code: 0 }, ['CLI:restart', 'API:POST /api/manager/restart']),
      step('log', ['dshc', 'log', '${host}', '-n', '20'], { code: 0 }, ['CLI:log', 'API:GET /api/hosts/:name/log']),
    ]),
  }),
  Object.freeze({
    id: 'configuration-and-safety',
    title: '配置同步、settings CAS 与不误杀边界',
    tier: 'harness',
    steps: Object.freeze([
      step('get-config', ['dshc', 'config', 'get'], { code: 0 }, ['CLI:config', 'API:GET /api/config']),
      step('set-config', ['dshc', 'config', 'set', 'hosts.${host}.workdir', '~/workspace'], { code: 0 }, ['CLI:config', 'API:PUT /api/hosts/:name/config']),
      step('settings-read', ['GET', '/api/hosts/${host}/dsh-settings'], { status: 200 }, ['API:GET /api/hosts/:name/dsh-settings']),
      step('settings-write', ['PUT', '/api/hosts/${host}/dsh-settings'], { status: 200 }, ['API:PUT /api/hosts/:name/dsh-settings']),
      step('fingerprint-refusal', ['harness', 'stop-with-mismatched-fingerprint'], { error: 'KILL_REFUSED' }, ['ERR:KILL_REFUSED', 'FSM:running→ready']),
    ]),
  }),
  Object.freeze({
    id: 'management-and-reload',
    title: '主机清单、批量同步、reload 与事件流',
    tier: 'integration',
    steps: Object.freeze([
      step('list', ['dshc', 'ls', '--json'], { code: 0, json: true }, ['CLI:ls', 'API:GET /api/hosts']),
      step('events', ['GET', '/api/events'], { event: 'snapshot' }, ['API:GET /api/events']),
      step('sync-preview', ['POST', '/api/hosts/sync-config', '{"dryRun":true}'], { status: 200, previewToken: true }, ['API:POST /api/hosts/sync-config']),
      step('reload', ['POST', '/api/reload'], { status: 200 }, ['API:POST /api/reload']),
    ]),
  }),
  Object.freeze({
    id: 'safe-failure-surfaces',
    title: '不可达、非法输入、端口与 setup gate',
    tier: 'harness',
    steps: Object.freeze([
      step('bad-host', ['dshc', 'start', 'missing-host'], { code: 3 }, ['CLI:start', 'CLI_EXIT:3', 'ERR:NOT_FOUND']),
      step('unreachable', ['dshc', 'start', '${unreachableHost}'], { code: 1 }, ['CLI_EXIT:1', 'ERR:SSH_UNREACHABLE', 'FSM:ready→unreachable']),
      step('timeout', ['harness', 'ssh-timeout'], { error: 'SSH_TIMEOUT' }, ['ERR:SSH_TIMEOUT', 'CLI_EXIT:2']),
      step('port-exhausted', ['harness', 'port-exhausted'], { error: 'PORT_EXHAUSTED' }, ['ERR:PORT_EXHAUSTED']),
      step('origin-fence', ['harness', 'wrong-origin'], { status: 403 }, ['ERR:FORBIDDEN_ORIGIN', 'ERR:FORBIDDEN_HOST']),
    ]),
  }),
]);

export const journeyBehaviorIds = Object.freeze(
  [...new Set(JOURNEYS.flatMap((journey) => journey.steps.flatMap((item) => item.behaviorIds)))],
);

/** §§1–8 的人工功能行锚点；正文由本规格生成，矩阵只保存这些可审计链接。 */
export const JOURNEY_MATRIX = Object.freeze([
  Object.freeze({ row: '§1', journey: 'center-first-run' }),
  Object.freeze({ row: '§2', journey: 'remote-host-closed-loop' }),
  Object.freeze({ row: '§3', journey: 'remote-resilience' }),
  Object.freeze({ row: '§4', journey: 'configuration-and-safety' }),
  Object.freeze({ row: '§5', journey: 'management-and-reload' }),
  Object.freeze({ row: '§6–§8', journey: 'safe-failure-surfaces' }),
]);
