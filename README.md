<div align="center">

[English](README.en.md) | 简体中文

</div>

# dsh-picflow

<p align="center">
  <img src="assets/screenshot-1.png" alt="输入框旁的「引用素材」面板：缩略图格子按编号从 图片506 排到 图片495，带时间与大小、按天筛选、最新/最早/最大排序，头部是「自动插入」开关" width="600">
</p>

## 一句话

粘贴的截图按编号引用：每一次 `Ctrl+V` 的图都会进入附件库、拿到固定编号（`图片N`）、列在输入框旁的面板里，并可以一键把「图片N」这张引用芯片插到光标处。

## 为什么需要它

往输入框 `Ctrl+V` 一张图，内核只把它当成**随手贴的草稿附件**——内存里的 object URL，字节要等你按发送才上传。在那之前，磁盘上的附件库根本没有它，于是谁都没法指向它：`@` 菜单里没有这一条，也没有一个编号让你说清「我刚才贴的那张」。

结果只能靠嘴描述：「第一张」「图2」——三张就说不清，切一趟对话回来更说不清。

dsh-picflow 补的就是这个缺口：**粘贴那一刻**就把图收进官方附件库，它拿到的编号，和发送之后是同一个；插进正文要么点一下，要么（开着自动插入时）一下都不用点。

## 它做什么

- **粘贴即入库。** 客户端每 350 ms 读一次输入框的实时草稿附件，把字节 POST 给插件自己的宿主路由，由宿主调用官方 `attachments.saveImage`。同一套规范化、同一个 sha256、同一个对象——所以不会出现两条记录，编号也不会变。
- **编号固定。** `图片N` 按全库文件 mtime 升序排定：最早的那张是 `图片1`。新图只会拿到**更大**的号，所以你昨天写下的编号，今天还是同一张图。
- **输入框旁的面板。** `N 张图` 胶囊展开成「引用素材」：最新的在最前，一格一张图，带编号、时间、大小，以及 `插到光标处`、`挂上`（把这张存图重新挂成当前消息的附件，模型直接看到图）、`路径`（复制 markdown 引用）。点缩略图是全屏放大浮层，点一下或 `Esc` 关闭。
- **搜索与筛选。** `图片12`、`10-04`、`昨天`、`png`、sha 前缀、`128kb` 都能搜；排序 `最新 / 最早 / 最大`，翻页一次 120 张。
- **时间桶，不是日期堆。** 筛选第一排恒定五枚：`全部 · 近3天 · 近7天 · 近30天 · 更早`（随时间滚动，永远不会越攒越长）；具体日期收进 `按日期` 开关里，要按天看再展开。
- **状态桶 + 使用账本。** 第二排是 `用过 · 没用过 · 已置顶 · 大文件 · 小噪音 · 可清理`，每枚带实时计数。插件自己记账：每一次「插到光标处 / 挂上 / 自动插入 / @ 选图」都会给那张图的 sha 记一次使用（存在 `<DSH_HOME>/dsh-picflow/usage.json`）。每张图因此有明确身份：**常用**（近 7 天用过、被置顶、或属于当前会话）、**用过**（近 30 天内）、**冷门**（用过但都在 30 天前，或从未被引用且入库满边界天数）、**新入库**。
- **头部数字是磁盘真话。** 面板顶部显示的不是当前窗口，而是全库真实占用、可清量（张数 + 体积）与最近一次使用时间。库里躺着 173 MB 时，它会说 173 MB。
- **清理向导（搬进回收站，7 天内可撤销）。** 候选规则写死在明处：**入库满 N 天（默认 14，可切 7 / 30）+ 从未被引用 + 未置顶 + 不属于当前会话**。打开「清理」后候选默认全勾，逐条写着它为什么是候选；点「移入回收站」把选中的图搬到 `<DSH_HOME>/trash/dsh-picflow/`（带清单，工作区里的缩略副本一并清掉），7 天内点「全部撤销」原样放回，到期才真删。**被任何会话引用过的图永远不会进候选**——回看历史不会丢图。
- **清理模式里也能看大图。** 「清理」的每一行末尾有一个 `🔍 看图` 按钮，缩略图本身也可点击：两者都打开全屏大图（点一下或按 Esc 关闭，底部写着 `图片N · 文件名 · 大小`），方便你逐张判断哪张删、哪张留。点图**不会**改动勾选——勾选只走行首那个复选框。
- **置顶。** 一格一个 `置顶` 按钮，置顶的图永远不进清理候选，格上挂「顶」标记。
- **`@图片` 源。** 打 `@` 会多出一个「图片」分组，选中插入的就是同一张编号引用芯片，和面板按钮完全等价。
- **自动插入（默认开）。** 开着时：入库完成后引用芯片自己落到光标处，面板不弹出来挡你打字。想改回手动，在面板头部点 `自动插入 开/关`——关掉后粘贴只入库，插不插由你点。这个选择记在 `localStorage` 里。
- **如实说明代价。** 因为入库发生在粘贴时，**一张图即便你最后没发送，也已经进了库。** 这正是它的意义，但它确实是行为变化，所以写在这里，而不是让你事后发现。清理向导就是为这句话准备的补救。

<p align="center">
  <img src="assets/screenshot-2.png" alt="正文里按光标位置插入的三张编号引用芯片：图片506、图片507、图片494" width="900">
</p>

<p align="center">
  <img src="assets/screenshot-3.png" alt="输入框下方的胶囊行：「505 张图」胶囊与宿主自带的胶囊并排" width="900">
</p>

## 安装

```sh
curl -fsSL https://raw.githubusercontent.com/XWIDE/dsh-picflow/main/install.sh | sh
```

**桌面端（Windows）**——桌面版不把 `dsh` 放进 PATH，上面那条在它身上跑不起来，用这条：

```powershell
iwr https://raw.githubusercontent.com/XWIDE/dsh-picflow/main/install.ps1 -useb | iex
```

它调用应用自带的插件操作入口（`resources\app\lib\plugin-cli.js`），只要 PowerShell 5.1 和装好的 DSH NEXT。卸载加 `-Remove`。

手动等价写法：

```sh
dsh plugin --profile web add git+https://github.com/XWIDE/dsh-picflow.git
```

```powershell
$exe = "$env:LOCALAPPDATA\Programs\DSH NEXT\DSH NEXT.exe"
& $exe --expose-internals "$((Get-Item $exe).Directory.FullName)\resources\app\lib\plugin-cli.js" desktop add github:XWIDE/dsh-picflow
```

装完**把承载插件的应用重启一次**——宿主半边在启动时注册 HTTP 路由：

- **DSH 桌面端**：重启 DSH NEXT（它标题栏的重启菜单里也有「重新加载界面」，但那只够刷新浏览器半边）。
- **`dsh web`**：重启 `dsh` 进程。

没有构建步骤、没有运行时依赖，源码安装直接可用，不会弹 `allowBuilds` 授权。

## 它怎么工作

| 部件 | 作用 |
| --- | --- |
| `GET  /plugins/dsh-picflow/version` | 廉价库指纹（只 `readdir` + `stat` 分片目录）。客户端每 3 秒问一次，变了才重取清单。 |
| `POST /plugins/dsh-picflow/admit` | body 就是图片字节。**按字节**嗅探格式（不信 `content-type`），调官方 `attachments.saveImage`，返回 `{sha, ordinal, label, bytes, ext, path?}`。 |
| `GET  /plugins/dsh-picflow/images` | 清单：`limit`、`materialize`、`offset`、`q`、`day`、`source`、`sort`、`pin`、`session`。`materialize=N` 把前 N 行落进工作区，`pin=<sha>` 只落指定那一张。 |
| `GET  /plugins/dsh-picflow/raw` | 图片字节，媒体类型也是按文件内容嗅探的。 |

四条路由都走宿主信任栅栏：默认只对回环地址开放，除非你把某个来源写进 `trustedHosts`。

`插到光标处` 需要一个模型读得到的路径，所以宿主会在你的工作区留一份副本：`<工作区>/.dsh/pics/pic-<MMDD-HHMM>-<sha8>.<ext>`（已有一模一样的副本就跳过），插入的引用芯片指向它，地址形如 `dsh-resource://file/absolute/...`。

## 兼容性

| dsh-picflow | Harness | 说明 |
| --- | --- | --- |
| 0.1.0 | **0.2.0-rc.2（实测）** | 针对桌面端 `0.2.0-rc.2` 开发与测试：真实 profile 上验证过 `install` 与 `start`；`uninstall` / `rollback` 标为 `unknown`，因为这个版本上还没实际演练过。 |
| 0.2.0 · 0.3.0 | **0.2.0-rc.2（实测）** | 与 `0.1.0` 同一份实测结论（`0.3.0` 只是版本号递进，代码与 `0.2.0` 相同）：`install` 与 `start` 在真实 profile 上验证过；`uninstall` / `rollback` 仍标 `unknown`。 |

宿主半边需要 Node.js 22.19+ 或 24+（与 harness CLI 自身的下限一致）。

浏览器半边由宿主模块加载器载入、`require('react')`；本插件不声明任何 npm 依赖，也不钉任何官方 `@deepseek-ai/*` 包，因此宿主 roster 的版本漂移不会把安装带崩。

## 配置

```yaml
- id: picflow
  name: 'dsh-picflow'
  config:
    trustedHosts: []        # 除回环外允许访问本插件路由的来源，如
                            # ["my-box.local:3080", "192.168.1.20:3080"] —— host[:port]
```

非回环来源没登记就访问路由会得到 `403`，响应里直接给出该补的那一行。

其余都是自动发现的，不需要配：附件库从 `DSH_HOME`（取不到时 `~/.dsh`）下的 `attachments/v1` 读，落盘副本写进会话自己的工作区。

## 边界

- **格式**：PNG、JPEG、WebP、GIF。官方附件库不收 BMP，`/admit` 会回 `400 unsupported-image`；改名伪装的文件按内容嗅探被拒，不看扩展名。
- **大小**：官方库单张上限 20 MB；`/admit` 的请求体上限 24 MB（超出回 `413 body-too-large`）。
- **清单**：单次请求默认 60 行、最多 400 行；面板一次翻 120 张。

## 隐私

不联网。插件只读本机附件库、只往会话工作区写副本，只跟宿主自己的回环路由通信；没有遥测，没有外部端点，图不会被重新上传到任何地方。

它只在本地留两样东西：`<工作区>/.dsh/pics/`（图片副本，引用要靠它解析）和一个 `localStorage` 键 `dsh-picflow.autoInsert`（那个开关）。

## 疑难

- **面板提示「宿主半边还是旧版」** —— 客户端半边比已加载的宿主模块新。重启应用；刷新页面换不掉宿主代码。
- **从局域网地址访问得到 `403`** —— 把那个 `host[:port]` 加进 `trustedHosts`（响应里给了可照抄的那行）。
- **粘了图但面板里没有** —— 草稿附件是数据源，所以图要真的落在**当前会话**的输入框里。面板的 `刷新` 会强制重取，`@图片` 读的是同一份清单。
- **点 `插到光标处` 说「还没落盘副本」** —— 引用需要磁盘路径；如果这个会话没有可写入的工作区，插件会退而给出纯 markdown 形式。
- **自动插入没触发** —— 它不跟你抢：输入框正忙（有回合在流式输出）或光标不在输入框时，它会改为弹出面板并说明原因，你点一下即可。
- **贴了又删掉的图还在库里** —— 预期行为，见上面的取舍。从库里删掉那个对象，面板里也就没了。

## 开发

```sh
node tests/host.mjs     # 宿主路由：24 项检查
node tests/chip.mjs     # 客户端半边：78 项检查（假加载器 + 假 React，不开浏览器）
```

两套测试都是纯 Node、零依赖。

## 卸载

```sh
dsh plugin --profile web remove dsh-picflow
```

想把落盘副本也清掉就删 `<工作区>/.dsh/pics/`；图片本体在官方附件库里，本插件不动它们。

## 许可

MIT —— 见 [LICENSE](LICENSE)。

## 作者

**X-WIDE** —— GitHub [@XWIDE](https://github.com/XWIDE) · B 站 [374064919](https://space.bilibili.com/374064919) · xiupk@sina.com.cn

有问题、想提需求，开 issue 就行。
