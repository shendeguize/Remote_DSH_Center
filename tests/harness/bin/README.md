# PATH 模式垫片（保留但非默认）

14 §1.1 原案：把本目录前置到 `PATH`，manager 代码零改动即走假远端。

**本机实测发现的问题**：经 shebang（`#!/usr/bin/env node`）启动的子进程收不到
`child.kill('SIGTERM')` 发出的信号——子进程连启动日志都不产生，却在收到 TERM 时
直接被杀死。后果是 `lib/ssh` 的「超时 → TERM → 2s → KILL」强杀链与 `tunnel.close()`
的主动杀无法被验证，而这两条正是最需要覆盖的路径。

**改用的方式**：`tests/harness/index.js` 走 `lib/ssh` 既有的
`DSHC_SSH_BIN` / `DSHC_SCP_BIN` 注入点，值形如
`"<node 绝对路径> <fake-ssh.js 绝对路径>"`（支持前导参数）。这让 node 成为
manager 的**直接**子进程，信号语义与真 ssh 一致。

本目录的两个垫片仍然保留，供手工排查（在终端里 `PATH=...:$PATH dshc probe`）使用。

复现实验：

```bash
printf '#!/usr/bin/env node\nprocess.on("SIGTERM",()=>console.log("handled"));setInterval(()=>{},500);\n' > /tmp/t.js
chmod +x /tmp/t.js
node -e 'const c=require("node:child_process").spawn("/tmp/t.js",[],{stdio:["ignore","pipe","pipe"]});
setTimeout(()=>c.kill("SIGTERM"),900); c.on("close",(x,s)=>console.log("close",x,s));'
# 观测：close null SIGTERM（handler 未生效）
# 改为 spawn(process.execPath, ["/tmp/t.js"]) 则输出 handled，2s 后才被 KILL
```
