# 师生协作部署说明（服务器版）

> 部署位置：`LZ@114.212.75.219:/home/LZ/yanxu/repo`
> 访问地址：**http://114.212.75.219:18700/**
> 更新日志：**http://114.212.75.219:18700/changelog.html**
> 最后验证：2026-11-18

## 一、给老师和同学的一句话

打开 http://114.212.75.219:18700/ → 用注册码注册（测试码 `nailong`）→ 在左下角「＋ 添加 API」填自己的 API Key → 开始用。

**AI 对话不消耗站长的额度**：每个人填自己的 Key，服务端不持有任何 Key。

## 二、这台机器的实际情况（踩过的坑）

| 项 | 实测结果 | 为什么要注意 |
|---|---|---|
| sudo | ❌ 需要密码 | 装不了系统包、改不了 nginx、用不了 systemd |
| 80 端口 | 被别人的 nginx 占用（`chart-extractor`） | 没法和别人抢 80，只能用高位端口 |
| 18125 | 同学 pxhao 在跑同项目的另一个实例 | 别动，我们另开 18700 |
| `nohup` 后台进程 | ❌ 会被 SSH 门禁回收 | 必须用 tmux |
| `git clone` | ❌ GnuTLS 中断 | 用 codeload 的 tar.gz 快照 |
| npm 全局前缀 | `/usr/local/node22`，无写权限 | 改到 `~/.npm-global` |
| Codex CLI | 装在 `~/.npm-global/bin` | 启动脚本必须显式加 PATH，否则 tmux 里找不到 |

## 三、目录结构

```
/home/LZ/yanxu/
├── repo/                     # 代码（从 GitHub tar 快照解开）
│   ├── .env                  # 服务器配置（不入库）
│   ├── .workbench/           # 运行时数据、server.log
│   └── .venv/                # Python 依赖
├── yanxu.sh                  # start / stop / restart / status / logs
└── yanxu-autostart.sh        # crontab 每 5 分钟自愈
```

## 四、日常操作

```bash
ssh LZ@114.212.75.219

# 看状态
~/yanxu/yanxu.sh status

# 改完代码后重启
~/yanxu/yanxu.sh restart

# 看日志
~/yanxu/yanxu.sh logs 100

# 看实时日志
tmux attach -t yanxu     # 退出用 Ctrl-B 然后按 D
```

## 五、更新代码的流程（已改为 git 同步）

**主人本地 push 之后，服务器上执行一条命令即可：**

```bash
~/yanxu/yanxu.sh update
```

它会：拉取远程 → 快进合并 → 对改动过的 .js 逐个做语法检查 → 通过才重启。
**任何一步失败都不会重启**，线上服务保持运行（代码可能已更新但跑的还是旧进程，
脚本会明确提示）。

`.env` / `.workbench` / `.venv` 都在 `.gitignore` 里，`git` 不会碰它们：
配置、任务数据、Python 环境在更新中安全。（`.venv` 实际是软链到 `/home/LZ/yanxu/.venv`，
不在仓库目录内。）

### 分支

服务器默认跟踪 clone 时指定的分支（当前 `feat/teacher-deploy`）。
要看别的分支或切分支：

```bash
~/yanxu/yanxu.sh update main        # 把服务器切到 main 并更新
```

### 首次建立（记录用，不用再执行）

原来的目录是 tar 快照、没有 .git，已在本轮改成真正的仓库：

```bash
mv repo/.venv .venv                  # 452M 移到仓库外，避免被 git 影响
mv repo repo_oldsnapshot             # 保留旧快照做兜底
git clone --branch feat/teacher-deploy   https://github.com/Pigkeeper-F/NJU-SZU-Server.git repo
ln -sfn /home/LZ/yanxu/.venv repo/.venv
cp repo_oldsnapshot/.env repo/.env
cp -a repo_oldsnapshot/.workbench/. repo/.workbench/
```

`repo_oldsnapshot` 确认没问题后可以删：`rm -rf /home/LZ/yanxu/repo_oldsnapshot`

### 老办法（tar 快照，仅当 git 不可用时）

```bash
cd /tmp
curl -sL -o r.tar.gz https://codeload.github.com/Pigkeeper-F/NJU-SZU-Server/tar.gz/refs/heads/main
mkdir -p /tmp/r && tar xzf r.tar.gz -C /tmp/r --strip-components=1
rsync -av --exclude='.env' --exclude='.workbench' --exclude='.venv' /tmp/r/ /home/LZ/yanxu/repo/
~/yanxu/yanxu.sh restart
```

> 注意 `--exclude`：`.env` 是这台机器的配置，`.workbench` 是任务数据，`.venv` 是环境。
> 覆盖这三个会把配置和用户数据冲掉。

## 五之二、更新代码的流程（旧版说明，保留备查）

服务器上 `git clone` 不可用（TLS 中断），所以走快照：

```bash
# 服务器上
cd /tmp
curl -sL -o r.tar.gz https://codeload.github.com/Pigkeeper-F/NJU-SZU-Server/tar.gz/refs/heads/main
mkdir -p /tmp/r && tar xzf r.tar.gz -C /tmp/r --strip-components=1
rsync -av --exclude='.env' --exclude='.workbench' --exclude='.venv' /tmp/r/ /home/LZ/yanxu/repo/
~/yanxu/yanxu.sh restart
```

> 注意 `--exclude`：`.env` 是这台机器的配置，`.workbench` 是任务数据，`.venv` 是环境。
> 覆盖这三个会把配置和用户数据冲掉。

## 六、本次改动（相对原仓库 main）

| 文件 | 改动 | 原因 |
|---|---|---|
| `server.js` | `PUBLIC_HOSTS` / `PUBLIC_ORIGINS` 环境变量 | 原代码只认 localhost，公网 IP 访问一律 403 |
| `server.js` | `redirectLoopback` 在服务器模式跳过 | 否则用户浏览器被跳到自己的 localhost |
| `server.js` | `REQUIRE_USER_KEY=1` | 多用户时必须用各自 Key，否则烧站长额度 |
| `server.js` | 按 IP 限流（`RATE_LIMIT_MAX`） | 一个人刷满不能让全班被限 |
| `server.js` | `/api/changelog` 路由 | 更新日志数据源 |
| `tools/changelog.js` | 新增 | 拉 GitHub 提交、缓存 5 分钟、失败标 stale |
| `changelog.html` / `css/changelog.css` / `js/changelog.js` | 新增 | 老师看的更新日志页 |
| `js/sidebar.js` | 侧栏「更新日志」按钮 | 工作台内一键跳转 |
| `config/changelog-notes.txt` | 新增 | 提交的中文说明（避免老师读英文摘要） |

## 七、更新日志怎么维护

老师看到的中文说明写在 `config/changelog-notes.txt`：

```
90dab47 = 部署适配：支持公网访问、访客各自填自己的 API Key
```

每次提交后补一行短 sha 即可。**不补也不会坏**，只是那一条显示 GitHub 英文原文。
改完不用重启，刷新页面就生效（按文件修改时间缓存）。

想换仓库/分支，改 `.env` 的 `CHANGELOG_REPO` / `CHANGELOG_BRANCH` 后重启。

## 八、已知边界（不要当成已完成）

1. **Codex 未登录**：`/api/codex/status` 返回 `loggedIn:false`。Codex CLI 已装（0.170.0），但登录需要本人扫码。没登录时依赖 Codex 的模块（部分清洗/绘图执行）用不了。
2. **文献五库未验证**：playwright + Chromium 已装且能启动，但知网/万方/WoS/Scopus 需要机构登录态，服务器上没有。要跑五库，得先在服务器上完成机构登录（可能要扫码/账密），这一步**没有做过**。
3. **登录是前端演示级**：注册码 `nailong` 写在 `js/auth-config.js`，任何人查看源码都能看到。数据各存各的浏览器，老师看不到学生的工作记录。真要账号体系得另外做服务端认证。
4. **端口 18700 是对外开放的**：任何知道地址的人都能访问。目前靠「注册码 + 自带 Key」限制。如果担心被扫到，可以考虑加 IP 白名单（需要改防火墙，目前无 sudo）。
5. **crontab 每 5 分钟探测**：机器重启后最多 5 分钟自动恢复。cron 依赖用户 crontab 权限，若管理员回收则失效。

## 九、排障

| 现象 | 检查 |
|---|---|
| 页面打不开 | `~/yanxu/yanxu.sh status`，看端口是否监听 |
| 全部请求 403 | `.env` 的 `PUBLIC_HOSTS` 是否和地址栏一致（含端口） |
| AI 对话报无 Key | 正常——本站不提供共享 Key，让用户自己填 |
| `/api/codex/status` 报断开 | `PATH` 是否含 `~/.npm-global/bin`；`codex --version` 是否可用 |
| 更新日志显示英文 | `config/changelog-notes.txt` 没写那条的说明，补一行即可 |
| 更新日志报错 | 服务器到 GitHub 的连接；`curl -I https://api.github.com` 验证 |
