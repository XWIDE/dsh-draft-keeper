<div align="center">

[English](README.en.md) | 简体中文

</div>

# dsh-draft-keeper

## 一句话

切走对话再回来，你刚粘进输入框的那张图还在。

## 为什么需要它

往输入框贴一张截图，内核只把它当成**随手贴的草稿附件**——内存里的对象，字节要等你按发送才上传。它属于**当前挂载的输入框**，不属于这个对话。于是切到另一个对话再切回来（或者输入框因为任何原因重新挂载），你得到的是一个空输入框，和一张要重新截一次的图。

别的东西也补不回来：发送之前磁盘上没有这份副本。这个插件就是自己留一份（存在你的浏览器里），再通过官方通道还回去。

## 它做什么

- **一边打字一边镜像。** 输入框里每一张图片草稿都会写进 IndexedDB，按会话分键；页内还有一层 Map 缓存，切换时比数据库先作答。打字不会重复读字节——附件 id 集合本身就是签名。
- **用官方通道还回去。** 输入框重新变空且空闲时，把镜像的图片重建成 `File`（名字、类型、`lastModified` 都保留），交给 `conversation.createDrafts` + `input.addAttachments`。之后你发出去的是一份普通附件，和刚粘贴的没有任何区别。若 `addAttachments` 拒收，会把它刚创建的草稿释放掉。
- **你完事了它就忘。** 只要输入框的附件从「有」变成「无」——消息发出去了，或者你自己把图删了——存的那一行立刻丢掉。用过的草稿绝不复活。
- **只镜像图片，是有意的。** 只处理 `kind === "image"` 的草稿：文件类草稿重新进 `createDrafts` 会让宿主重启一次上传。文档一律按宿主原有方式处理，不碰。
- **上限与顺序。** 每会话 12 张图 / 32 MB；同一会话的捕获走 Promise 链串行，后来的绝不会插到前面；输入框保持空闲时最多尝试恢复 6 次。

## 它怎么工作

| 部件 | 作用 |
| --- | --- |
| `conversation.input.dock` 子组件（id `draft-keeper`、order 30） | 无界面组件：它的挂载本身就是「输入框活着」的信号。它订阅 `input.state`，对每次发布的状态快照作出反应。 |
| 捕获 | 附件 id 非空 → 用 `conversation.resolveDraftAttachments` 取到活的草稿，读每张图的字节，存 `{name, type, lastModified, bytes}`；id 集合没变就跳过。 |
| 恢复 | id 为空、之前也没观察到过附件、且 `state.phase === "plain"` → 重建 `File` 并重新挂上。输入框正在处理发送时它保持安静；已经有附件时也不插手。 |
| 遗忘 | id 从非空变空 → 丢掉那一行。发出去了还是你删了，都不该再回来。 |
| 存储 | IndexedDB `dsh-draft-keeper`（store `drafts`，键 `sessionId`，行 `{sessionId, records, updatedAt}`）加一层页内 `Map`。都按浏览器 profile、按会话隔离。 |

宿主半边（`index.js`）是一个空的 `apply()`：它存在只是为了让这个 bundle 可安装，行为全在客户端半边。

## 安装

```sh
curl -fsSL https://raw.githubusercontent.com/XWIDE/dsh-draft-keeper/main/install.sh | sh
```

**桌面端（Windows）**——桌面版不把 `dsh` 放进 PATH，上面那条在它身上跑不起来，用这条：

```powershell
iwr https://raw.githubusercontent.com/XWIDE/dsh-draft-keeper/main/install.ps1 -useb | iex
```

它调用应用自带的插件操作入口（`resources\app\lib\plugin-cli.js`），只要 PowerShell 5.1 和装好的 DSH NEXT。卸载加 `-Remove`。

手动等价写法：

```sh
dsh plugin --profile web add git+https://github.com/XWIDE/dsh-draft-keeper.git
```

```powershell
$exe = "$env:LOCALAPPDATA\Programs\DSH NEXT\DSH NEXT.exe"
& $exe --expose-internals "$((Get-Item $exe).Directory.FullName)\resources\app\lib\plugin-cli.js" desktop add github:XWIDE/dsh-draft-keeper
```

装完**重启应用一次**，让这个 bundle 进入宿主模块图：

- **DSH 桌面端**：重启 DSH NEXT（此后标题栏重启菜单里的「重新加载界面」就够刷新浏览器半边了）。
- **`dsh web`**：重启 `dsh` 进程，然后刷新页面。

没有构建步骤、没有运行时依赖，源码安装直接可用，不会弹 `allowBuilds` 授权。

## 兼容性

| dsh-draft-keeper | Harness | 说明 |
| --- | --- | --- |
| 0.1.0 | **0.2.0-rc.2（实测）** | 针对桌面端 `0.2.0-rc.2` 开发与测试；真实 profile 上验证过 `install` / `start`；`uninstall` / `rollback` 标为 `unknown`，因为这个版本上还没实际演练过。 |

宿主半边需要 Node.js 22.19+ 或 24+（与 harness CLI 一致的下限）。浏览器半边不声明任何 npm 依赖、也不钉任何官方 `@deepseek-ai/*` 包，因此宿主 roster 的版本漂移不会把安装带崩。

## 配置

没有。没有界面、没有可配项：装上就干这一件事。

## 边界

- **只保图片。** 文档和其它文件类草稿不镜像，这是刻意的（原因见上）。
- **按会话、按浏览器。** 镜像存在贴图那个浏览器 profile 里；换浏览器或清掉站点数据就是空的。
- **每会话 12 张 / 32 MB。** 超出之后不再补录（绝不会动你输入框里现有的东西）。
- **时机。** 恢复要等输入框变空、且处于 `plain` 阶段；这次挂载最多试 6 次。如果你在已有附件的情况下继续打字，它不会插手。

## 隐私

粘贴的图片字节**只存在本地**——这个浏览器的 IndexedDB 里，按当时那个会话分键。不外发：没有宿主路由、没有网络请求、没有遥测。输入框附件一旦清空（发出或你删除），存的那一行立刻丢掉。

## 疑难

- **切回来什么都没恢复** —— 只保图片；如果那个对话里从来没有过图片草稿，就没有可恢复的东西。另外确认输入框当时是空的：已经挂着附件的输入框它故意不碰。
- **有回合在跑的时候没恢复** —— 那时输入框不是 `plain` 阶段。只要输入框还挂着，它会继续重试，最多 6 次。
- **发出去之后那张图没有回来** —— 这正是设计：附件集合一旦归零，存的行就丢掉，不让它事后复活。
- **清掉站点数据后图没了** —— 镜像就是浏览器存储，清掉即删（已经发出去的消息不受影响）。

## 开发

```sh
node tests/harness.mjs     # 18 项检查：捕获、恢复、遗忘、上限、阶段处理
```

测试跑在纯 Node 上、零依赖（假的输入框壳、假的 IndexedDB、假的 React）。

## 卸载

```sh
dsh plugin --profile web remove dsh-draft-keeper
```

想在浏览器站点数据里顺手清掉镜像也可以（IndexedDB 数据库 `dsh-draft-keeper`）；它很小，而且草稿一清空自己就删。

## 许可

MIT —— 见 [LICENSE](LICENSE)。

## 作者

**X-WIDE** —— GitHub [@XWIDE](https://github.com/XWIDE) · B 站 [374064919](https://space.bilibili.com/374064919) · xiupk@sina.com.cn

有问题、想提需求，开 issue 就行。
