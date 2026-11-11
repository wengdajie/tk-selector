# 选片台 · TK 产品视频工作台

给 TikTok 内容团队用的视频选片 / 素材管理 / 需求协作工具。跑在本地 NAS 上，Docker 单容器部署，数据不出内网。

## 解决什么问题

拍摄每天拍回来一堆素材，运营散在群里问「这条能不能用」——选片台把这条链路固化下来：

| 环节 | 以前 | 现在 |
|---|---|---|
| 拍摄交付 | 微信/网盘发一堆文件 | 丢进 NAS 共享文件夹，自动入库并按拍摄日期分好 |
| 运营找素材 | 翻聊天记录、下载到本地再看 | 网页里按日期浏览，卡片/列表切换，直接在线播放 |
| 谁拿了哪条 | 无记录，重复要片 | 每次下载自动记人，卡片上直接显示「最近谁下过」 |
| 好不好用 | 全靠嘴说 | 1-5 星评分，可按「已标星」「4 星+」筛，按评分排序 |
| 反馈 | 群里打字，找不到上下文 | 每条素材下独立评论区 |
| 通用素材沉淀 | 过几天就找不到 | 素材库，所有人可上传，打标签检索 |
| 运营提需求 | 口头说，容易漏 | 需求板：发布 → 认领 → 交付 → 关联素材 |
| 找人 | 手动加账号 | 自助注册（名字 + 密码），内置管理员兜底 |
| 团队进度 | 每周开会问一遍 | **工作仪表盘**：素材、评论、下载、评分、需求完成情况一屏看完 |

## 快速开始（群晖 DSM 7.x）

### 1. 准备共享文件夹

在 File Station 建两个共享文件夹：

- `选片台数据` — 存数据库和视频文件（**必须**）
- `拍摄投递` — 拍摄每天往里丢视频（可选，也可以只用网页上传）

### 2. 上传代码

把整个 `tk-selector` 目录传到 NAS，例如 `/volume1/docker/tk-selector`。

### 3. 改配置

在 `/volume1/docker/tk-selector/` 下**先手工建一个空的 `data` 文件夹**（群晖不会自动创建挂载点），然后编辑 `docker-compose.yml`：

```yaml
ports:
  - "8899:8080"       # 宿主机端口:容器端口；88 常被群晖系统占用，建议用 8899
environment:
  PUID: "1026"        # 你的群晖账号 UID
  PGID: "100"         # 你的群晖账号 GID
volumes:
  - ./data:/data
  - /volume1/拍摄投递:/watch:ro
```

> UID/GID 查看方式：控制面板 → 用户与群组 → 选中你的账号 → 编辑 → 用户信息。
> 首个创建的用户一般是 `1026` / `100`。

### 4. 启动

**方式 A：Container Manager（图形界面）**
Container Manager → 项目 → 新增 → 路径选 `/volume1/docker/tk/tk-selector` → 来源选「创建 docker-compose.yml」粘贴上面的配置 → 下一步 → 完成。

**方式 B：SSH**

```bash
cd /volume1/docker/tk/tk-selector
sudo docker compose up -d --build
```

### 5. 打开

浏览器访问 `http://NAS的IP:8899`（端口按你上面的映射改）。

登录后默认进入**工作仪表盘**：今天新增了多少素材、团队评论与下载情况、评分分布、高分素材榜、成员活跃度、需求状态和最近动态，都集中在这一页，数据直接从业务表统计，改完素材回来就是最新的。

右上角太阳/月亮图标切换**亮色 / 深色主题**（默认跟随系统，手动切换后会记住）。

---

## 账号与说明

系统采用**统一登录入口**，没有「先选身份再进」的步骤：一个页面里切换「登录 / 注册新账号」。

### 内置管理员（首次部署即可用）

| 项目 | 值 |
|---|---|
| 账号（名字） | `管理员` |
| 初始密码 | `tkadmin2026` |
| 角色 | 管理员 |

用途：首次部署后用它登录、添加成员、管理账号与密码、发布需求、审片下载。**登录后请立刻在「右上角头像 → 修改密码」里改掉初始密码。**

密码可用环境变量覆盖：

```yaml
environment:
  ADMIN_NAME: 管理员
  ADMIN_PASSWORD: 换成你自己的初始密码
```

> 升级说明：从旧版本（无密码、选身份进入）升级时，所有历史账号会被统一设置成上面这个初始密码，容器启动日志里会列出被初始化的账号名。

### 注册与新成员

- 自助注册：填名字、选角色（运营 / 拍摄 / 只读）、设置密码（至少 6 位）
- 管理员可在「成员」页直接添加成员并指定初始密码；管理员角色只能由管理员创建
- 任何人都能改自己的密码（需验证当前密码）；管理员可重置他人密码

---

## 怎么用

### 拍摄：把视频交上去

两种方式，随便挑：

1. **丢文件夹**（推荐）：把当天素材复制到 NAS 的 `拍摄投递` 文件夹。系统每 5 分钟扫一次，自动识别日期（优先从路径里的 `2026-11-11` 这类日期取，取不到就用文件修改时间），生成缩略图、读取时长和分辨率后入库。
2. **网页上传**：右上角「上传视频」，可多选、可拖拽。

重复素材靠文件内容指纹（大小 + 首尾 1MB 的 MD5）自动去重，同一支片子重复投递只会入库一次。

### 运营：选片和下载

- 左侧「每日选片」，默认看今天；上方日期条切换历史素材
- **日期范围**：日期条上的「选范围」可按起止日期筛，也可以点「近 7 天 / 近 30 天 / 本月」快捷选
- 卡片模式看缩略图，列表模式看规格（分辨率 / 时长 / 体积）
- **评分**：鼠标移到卡片上，标题右侧出现 5 颗星，点一下即评分，再点同一颗取消。筛选项里有「已标星」「4星+」，排序可选「评分最高」
- 批量评分：勾选多条 → 底部操作条点「评分」→ 选星级
- 点卡片打开详情：在线播放、看评论、打标签
- 勾选多条 → 底部浮出操作条 → **打包下载**（自动打 zip，保留原文件名）
- 下载即记录：谁、什么时候、拿了哪几条，卡片右上角会显示「最近下载人」

### 素材库

「存入素材库」把好用的通用素材从每日池子挪到长期库，所有人可上传、可搜索、可打标签。

### 视频需求

运营在「视频需求」里发布需求（标题、描述、优先级、截止日期、标签）。

拍摄点「我来拍」认领 → 状态自动变「进行中」→ 上传交付素材时选「上传交付」，视频自动挂到需求下 → 完成后点「标记完成」。

---

## 在线升级（从 GitHub 拉新版）

代码托管在 GitHub，升级有两条路，按你的网络与习惯选一条。

### 方式 A：只换源码，不重新构建（推荐）

前提：容器把源码目录挂载进来（见 `docker-compose.source.yml`）。在项目 YAML 的 `volumes` 里加两行：

```yaml
    volumes:
      - ./data:/data
      - /volume1/拍摄投递:/watch:ro
      - ./server:/app/server
      - ./public:/app/public
```

保存 → 重新部署（只重建容器，十几秒，**不构建镜像**）。之后每次升级只需：

```
# 群晖「任务计划」，用户选 root
curl -fsSL https://raw.githubusercontent.com/wengadajie/tk-selector/main/scripts/nas-upgrade.sh -o /tmp/up.sh && sh /tmp/up.sh
```

脚本会：备份 `public`/`server` → 从 GitHub 下载最新源码 → 覆盖（不动 `data`）→ 重启容器 → 打印当前版本。整个过程十几秒。

### 方式 B：用 CI 构建好的镜像

仓库里的 GitHub Actions 会在每次 push 后自动构建镜像并推到 GHCR（`ghcr.io/wengadajie/tk-selector:latest`，linux/amd64）。群晖上把 compose 的 `build: .` 换成 `image:` 即可：

```yaml
services:
  tk-selector:
    image: ghcr.io/wengadajie/tk-selector:latest
    # build: .        ← 删掉这行
```

升级：`docker compose pull && docker compose up -d`（或 Container Manager 里「操作 → 拉取镜像并重启」）。

> 国内 NAS 拉 GHCR 可能很慢，若卡住请用方式 A。

### 怎么确认升级成功

访问 `http://NAS的IP:端口/api/version`，返回的 `version` 与 `frontendBuiltAt` 就是当前镜像里真实生效的代码版本。

## 数据与备份

所有状态都在 `data/` 目录：

```
data/
├── app.db                  SQLite（成员、素材元数据、评论、下载记录、需求）
├── app.db-wal / app.db-shm
├── media/
│   ├── daily/2026-11-11/   每日素材（文件名是 UUID，原始名存在库里）
│   ├── library/            素材库
│   └── thumbs/             缩略图（可删，会重新生成）
└── watch/                  本地开发用的投递目录（Docker 里用挂载的 /watch）
```

**备份**：整个 `data/` 目录打包即可（建议停容器后备份，或用群晖 Hyper Backup 做快照）。

**注意**：数据库是唯一事实来源。手动在 `media/` 里挪文件会导致记录失效，请在网页里操作。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8080 | 监听端口 |
| `DATA_DIR` | `/data` | 数据根目录 |
| `MEDIA_DIR` | `/data/media` | 视频文件目录 |
| `SCAN_DIR` | `/watch` | 拍摄投递扫描目录 |
| `SCAN_MODE` | `copy` | `copy` 复制入库（投递目录保留原件）/ `move` 移动入库（省空间）/ `link` |
| `SCAN_INTERVAL` | 300 | 扫描间隔秒数，`0` 关闭定时扫描 |
| `SCAN_IGNORE` | `@eaDir,#recycle,...` | 扫描跳过的目录名（群晖系统目录已内置） |
| `ADMIN_NAME` | 管理员 | 内置管理员账号名（首次启动创建；已有管理员则只补密码） |
| `ADMIN_PASSWORD` | tkadmin2026 | 内置管理员初始密码，也是历史无密码账号的初始化密码 |
| `ACCESS_CODE` | 空 | 设置后新增/删除成员需输入口令 |
| `MAX_UPLOAD_MB` | 4096 | 单文件上传上限 |
| `TZ` | Asia/Shanghai | 时区，影响「今天」的判定 |

## 本地开发

```bash
npm install
npm start          # http://127.0.0.1:8080
```

需要本机有 `ffmpeg` / `ffprobe`（用于抽帧和读元数据）。Windows 上可以用 `winget install ffmpeg`。

造一批演示数据：

```bash
node scripts/seed-demo.mjs       # 3 条需求 + 认领 + 评论 + 下载记录
node scripts/smoke.mjs           # 18 项接口冒烟测试
```

演示数据只写进 `data/app.db`，正式部署前删掉 `data/` 目录即可从零开始。

调试用 URL 参数：

- `?as=<用户ID>` 指定身份进入（`/api/users` 能看到 ID）
- `?view=library|requests|records|members` 直接打开某个视图
- `?layout=list` 列表模式
- `?theme=light|dark` 强制主题
- `?open=<视频ID>` 直接打开某条素材的详情

## 常见问题

**Q：构建特别慢（20 分钟以上）？**
`Dockerfile` 默认已把 apt 源指向 `mirrors.aliyun.com`、npm 指向 `registry.npmmirror.com`。如果自己改回过官方源，在国内会慢到不可用。可临时覆盖：

```bash
docker compose build --build-arg APT_MIRROR=mirrors.aliyun.com --build-arg NPM_REGISTRY=https://registry.npmmirror.com
```

**Q：构建报 `groupadd: GID '1000' already exists`？**
基础镜像 `node:22-bookworm-slim` 自带 `node` 用户占用 1000。当前 `Dockerfile` 已改成「先用 1001，占用了就自动分配」，并加了 `getent` 守卫；如果你改过这一段，注意别再写死 1000。

**Q：启动报 `Bind mount failed: '/volume1/docker/tk/tk-selector/data' does not exist`？**
群晖的 Docker 不会自动创建 bind mount 的宿主机目录。先在 File Station 里把 `data` 文件夹建好（同理 `/volume1/拍摄投递` 也要存在），再启动。

**Q：启动报 `driver failed programming external connectivity on endpoint ...`？**
宿主机端口被占用（群晖的 88 就常被系统服务或旧容器占着）。改 `docker-compose.yml` 里的端口映射即可，不用重新构建镜像：

```yaml
ports:
  - "8899:8080"
```

**Q：容器起来了但视频扫不进去？**
看容器日志 `docker logs tk-selector`。常见原因：
1. `PUID/PGID` 和 NAS 账号不一致 → `data` 目录写不进去
2. 投递目录挂载路径写错，或该共享文件夹没给 Docker 读权限
3. 日志提示「扫描目录不存在」→ 检查 `volumes` 里 `:/watch:ro` 的宿主机路径

**Q：卡片没有缩略图？**
容器内 `ffmpeg` 抽帧失败会降级成占位图，日志里会有 `[media] ffmpeg 抽帧失败`。可以先 `docker exec tk-selector ffmpeg -version` 确认。

**Q：视频播放卡顿？**
播放走 HTTP Range 直读 NAS 文件，只转封装不转码。局域网建议千兆；跨公网访问请走 VPN，不建议直接暴露端口。

**Q：手机能用吗？**
可以，界面做了窄屏适配。竖屏素材在手机上浏览体验更好。

**Q：想限制成员权限？**
注册时给账号设密码，别人就进不去你的身份了（密码用 scrypt 加盐哈希存储）。但这仍是「按账号标记操作人」的模型，不做细粒度权限；要更强的隔离，可设置 `ACCESS_CODE` 保护成员管理，或在前面挂一层 Nginx Basic Auth / 群晖反向代理认证。

**Q：忘了密码怎么办？**
管理员登录后可在成员页重置（`POST /api/users/:id/password`，管理员调用时不需要旧密码）。若唯一的管理员也忘了密码：把 `data/app.db` 里该账号的 `password_hash` 清空后重启容器，启动时会自动按 `ADMIN_PASSWORD`（默认 `tkadmin2026`）补上：

```bash
sqlite3 data/app.db "UPDATE users SET password_hash=NULL WHERE role='admin'"
docker restart tk-selector
```

**Q：怎么确认部署的是最新版本？**
浏览器直接打开 `http://NAS的IP:端口/api/version`，返回当前镜像里的版本号和前端文件时间。升级后如果版本号没变，说明镜像没重建（覆盖源码不会自动生效，必须在 Container Manager 里停止项目后点「构建」）。

**Q：仪表盘数据不准 / 是空的？**
仪表盘所有数字都是查询时实时聚合的，没有缓存。空库自然全是 0；如果和预期不符，先确认容器时区是 `Asia/Shanghai`（`TZ` 环境变量），「今天」的边界依赖它。

## 技术栈

- 后端：Node.js 22 + Express + better-sqlite3（WAL）
- 媒体：ffmpeg / ffprobe（抽帧、时长、分辨率）
- 前端：原生 ES Module，无构建步骤，无框架
- 部署：单容器，数据卷挂载
