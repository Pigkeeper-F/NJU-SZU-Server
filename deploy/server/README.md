# 服务器运维脚本（南大 114.212.75.219）

这些是部署在服务器上的脚本的**版本库副本**，方便追溯与复现。
实际运行位置是 `/home/LZ/yanxu/`，服务器上的那份才是生效的。

| 文件 | 服务器路径 | 作用 |
|---|---|---|
| `yanxu.sh` | `/home/LZ/yanxu/yanxu.sh` | start / stop / restart / update / status / logs |
| `yanxu-update.sh` | `/home/LZ/yanxu/yanxu-update.sh` | 从 GitHub 拉取并重启（`yanxu.sh update` 调它） |
| `yanxu-autostart.sh` | `/home/LZ/yanxu/yanxu-autostart.sh` | crontab 每 5 分钟兜底拉起 |
| `server.env` | `/home/LZ/yanxu/repo/.env` | 该机器的运行配置模板 |

## 部署与更新

完整步骤、这台机器的硬约束（无 sudo、端口占用、nohup 被回收）见
[`docs/deploy-teacher-server.md`](../../docs/deploy-teacher-server.md)。

日常只有一条：

```bash
~/yanxu/yanxu.sh update
```

## 改脚本后怎么生效

改完这个目录里的文件，推到 GitHub，然后在服务器上重新拷一次：

```bash
cd /tmp
curl -sL -o r.tar.gz https://codeload.github.com/Pigkeeper-F/NJU-SZU-Server/tar.gz/refs/heads/feat/teacher-deploy
mkdir -p /tmp/r && tar xzf r.tar.gz -C /tmp/r --strip-components=1
cp /tmp/r/deploy/server/*.sh /home/LZ/yanxu/ && chmod +x /home/LZ/yanxu/*.sh
```

> 脚本不在 `repo/` 里，所以 `yanxu.sh update` 不会更新脚本本身 ——
> 这是刻意的：更新脚本出错会把唯一能修它的工具也弄坏。
