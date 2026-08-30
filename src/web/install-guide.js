/**
 * dsh 安装与配置指引（CLI/页面共用纯模块）。
 *
 * 这里只生成说明文字，不执行命令、不探测文件系统，也不把嗅探结果用于可用性判据。
 */

const DEFAULT_PROFILE = '$HOME/.dsh/profiles/web';
const COMMON_PATH_DIRS = ['/usr/local/bin', '/usr/bin', '/bin', '/opt/homebrew/bin'];

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function sniffPaths(sniff) {
  if (!Array.isArray(sniff?.paths)) return [];
  return [...new Set(sniff.paths.map(nonEmpty).filter(Boolean))];
}

function pathDirectories(probePath) {
  return new Set(String(probePath ?? '').split(':').map(nonEmpty).filter(Boolean));
}

function suggestedPathDir(probePath) {
  const visible = pathDirectories(probePath);
  return COMMON_PATH_DIRS.find((dir) => visible.has(dir)) ?? '/usr/local/bin';
}

function targetWord(local) {
  return local ? '本机' : '远端';
}

function dependencyState(dependencies, key, fallback = false) {
  return typeof dependencies?.[key] === 'boolean' ? dependencies[key] : fallback;
}

function buildChecklist({ binary, webProfile, bash, timeout, dshHome, target }) {
  const profile = nonEmpty(dshHome) ? `${dshHome}/profiles/web` : DEFAULT_PROFILE;
  return [
    {
      id: 'binary',
      label: 'dsh 可执行文件',
      status: binary ? 'pass' : 'fail',
      detail: binary ? '已找到可执行文件' : `${target}未找到可执行的 dsh`,
      commands: ['command -v dsh', 'dsh --version'],
    },
    {
      id: 'web-profile',
      label: 'dsh web profile',
      status: webProfile ? 'pass' : 'fail',
      detail: webProfile ? `已发现 ${profile}` : `未发现 ${profile}`,
      commands: [`test -d ${JSON.stringify(profile)} && echo "web profile: ready"`],
    },
    {
      id: 'bash',
      label: 'bash（login shell 嗅探，可选）',
      status: bash ? 'pass' : 'optional',
      detail: bash ? '已安装' : '未发现；不影响已解析的 dsh',
      commands: ['command -v bash'],
    },
    {
      id: 'timeout',
      label: 'timeout（login shell 嗅探，可选）',
      status: timeout ? 'pass' : 'optional',
      detail: timeout ? '已安装' : '未发现；不影响已解析的 dsh',
      commands: ['command -v timeout'],
    },
  ];
}

/**
 * @param {{local?:boolean, noDshReason?:string|null, sniff?:object,
 *   dshHome?:string|null, dependencies?:object}} input
 * @returns {{summary:string, steps:string[], checks:object[]}}
 */
export function buildInstallGuide({
  local = false,
  noDshReason = null,
  sniff = null,
  dshHome = null,
  dependencies = null,
} = {}) {
  const target = targetWord(local);
  const paths = sniffPaths(sniff);
  const loginPath = nonEmpty(sniff?.loginPath);
  const foundPath = paths[0] ?? loginPath;
  const checks = buildChecklist({
    binary: dependencyState(dependencies, 'binary', Boolean(foundPath)),
    webProfile: dependencyState(dependencies, 'webProfile', noDshReason === null),
    bash: dependencyState(dependencies, 'bash'),
    timeout: dependencyState(dependencies, 'timeout'),
    dshHome,
    target,
  });

  if (noDshReason === 'missing-bin' && foundPath) {
    const pathDir = suggestedPathDir(sniff?.probePath);
    return {
      summary: `已发现 dsh（${foundPath}），但${target}非交互环境的 PATH 找不到它。`,
      steps: [
        `让${target}执行 dsh 的非交互 SSH 环境能够解析 ${foundPath}。`,
        `可将 dsh 链接到当前 PATH 已包含的目录（例如 ${pathDir}），或为非交互 SSH shell 配置包含其目录的 PATH；仅修改交互 shell 的 .bashrc 不一定生效。`,
        '完成后重新执行 dshc probe <host>，确认状态变为“可拉起”。',
      ],
      checks,
    };
  }

  if (noDshReason === 'no-web-profile') {
    const profile = nonEmpty(dshHome) ? `${dshHome}/profiles/web` : DEFAULT_PROFILE;
    return {
      summary: `${target}已找到 dsh，但未发现 web profile（${profile}）。`,
      steps: [
        '执行 dsh plugin --profile web list，让 dsh 惰性初始化 web profile。',
        '仅当需要管理 profile 插件时，先确保 pnpm 在 PATH；Center 不会代为安装插件。',
        '完成配置后重新执行 dshc probe <host>，确认状态变为“可拉起”。',
      ],
      checks,
    };
  }

  return {
    summary: `未探测到${target}可执行的 dsh。`,
    steps: [
      '按 dsh 官方安装文档安装 dsh；Center 不会代为安装。',
      '配置 dsh web profile，并确保非交互 SSH 环境能够找到 dsh。',
      '完成后重新执行 dshc probe <host>，确认状态变为“可拉起”。',
    ],
    checks,
  };
}
