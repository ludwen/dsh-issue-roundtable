# 议题圆桌（dsh-issue-roundtable）

DSH Desktop 的工作台插件：为同一个议题定义多个**不同角色的发言 agent**，让它们按轮次真实交锋，最后由全体投票表决出一个方案。

## 它能做什么

- **角色可自定义**：名称、关注点、立场与说话方式。内置产品经理 / 技术负责人 / 财务负责人 / 用户代表四个角色，可改可删可加（1~8 个）。
- **多轮真实讨论**：每位角色、每一轮都独立调用一次模型；它们能看到议题、共用资料和**所有已经发生过的发言**，第 2 轮开始必须回应别人的观点，最后一轮必须收敛。
- **共享资料**：可开启联网检索，检索结果对全体角色共享（检索不可用时降级为说明，不影响讨论）。
- **书记员收敛**：讨论结束后由一位书记员把讨论收敛成 2~4 个**可表决的候选方案**（含要点与取舍）。
- **全体投票**：每位角色独立投一票并给出理由；多数票胜出，平票自动进入一轮复选，复选仍平票时由书记员推荐裁定，并明确写出裁定方式。
- **结论可带走**：结论卡片给出方案正文、要点、取舍、票数、少数意见（异议与理由）、待解决的关键问题，可一键复制。
- **历史与续跑**：每次讨论存为一条历史记录，可回看全文。讨论引擎跑在宿主进程里，切换工作台、关闭面板或刷新页面都不会中断讨论。

## 一次讨论的流程

```
议题 + 角色 + 轮数
  └─ 联网检索（可选，一次，共享）
      └─ 第 1..N 轮：角色依次发言（顺序固定，都能看到前面的发言）
          └─ 书记员收敛成 2~4 个候选方案
              └─ 全体投票（每人一票 + 理由）
                  └─ 多数票胜出 / 平票进入复选
                      └─ 结论文案 + 少数意见 + 待解决问题
```

费用大致是：`轮数 × 角色数` 次发言 + `1~2` 次书记员 + `角色数`（+ 复选时再加 `角色数`）次投票。

## 安装

在 DSH Desktop 里由 Agent 或插件管理安装本包：

```bash
pnpm pack
```

然后把生成的 `dsh-issue-roundtable-<version>.tgz` 装进当前 profile。安装后需要重启 Harness，展开左侧栏，在左上角「工作台」右侧的当前名称/切换区域选择「议题圆桌」。

**关于 `register()` 里的 `repository`**：Desktop 0.12.x 会丢弃无法归属到单一仓库的工作台提供方，只有 0.13.0 起才支持纯本地身份 `local:<npm 包名>`。为兼容本机 0.12.1，客户端注册时写入了 `https://github.com/ludwen/dsh-issue-roundtable`（作者自己的 GitHub 命名空间，仓库名与 npm 包名一致）。它只用于稳定身份：不发布代码，不上传任何内容；日后建仓不改身份，升级到 0.13.0 时既有归属也继续有效。

## 数据位置

业务数据保存在插件配置的 `root` 目录（默认 `$DSH_HOME/issue-roundtable`）：

| 文件 | 内容 |
|---|---|
| `roles.json` | 角色设定 |
| `settings.json` | 轮数、是否联网检索、上次参与的角色 |
| `history.json` | 最近的讨论记录（上限 40 条，可在面板删除） |

卸载插件不会删除这些文件。

## 结构

```
package.json          npm 与 DSH 插件声明
cordis.patch.yml      把宿主入口插进插件树（name 必须写包名）
dsh/index.js          宿主：角色存储、讨论引擎、/api/issue-roundtable 路由
lib/client.js         客户端：工作台业务面板（已构建的单文件模块）
locale/{zh,en}.json   市场与卡片用的名称、简介
test/smoke.mjs        宿主引擎的离线烟雾测试（假模型 + 假 ctx）
test/panel.mjs        面板在 jsdom 下的渲染与交互测试
test/installed.mjs    用 Desktop 的模块回退导入「已安装」的包并挂载
test/register.mjs     用 Desktop 真实的 Workbenches 服务校验 register()
test/live.mjs         对运行中的 Host 跑一场真实模型讨论（走 /api 验收全链路）
```

## 自测

```bash
node test/smoke.mjs   # 28 项：路由、发言轮次、书记员、投票、平票复选、校验与 404
node test/panel.mjs   # 20 项：工具栏唯一性、设置页、讨论视图、表决结果、角色编辑器、无横向溢出
node test/installed.mjs <已安装的包目录>   # 按 Host 的模块回退方式加载已安装包并挂载
node test/register.mjs                     # 真实 register()：身份、descriptor、catalog、marketCatalog
node test/live.mjs <token-url>             # 真实模型：起一场讨论并核验发言/方案/投票/结论
```

前四个脚本不联网、不读取真实模型。`test/panel.mjs`、`test/register.mjs` 从 DSH 安装目录借用 `jsdom`、`react`、`react-dom` 与真实的 `dsh-desktop-workbenches/client.js`（脚本内已写好路径）；`test/installed.mjs` 借用 Desktop 的 `host-module-fallback.mjs`，验证的就是「安装产物能否被 Host 导入」；`test/live.mjs` 通过认证 cookie 调用运行中的 Host，会真实消耗模型额度。

## 已知限制

- 发言是**串行**的：一位角色一位角色地调用模型，一轮 4 个角色大约 1~3 分钟，5 轮会更久。投票是并行的。
- 角色没有工具能力，只输出观点文字；联网资料由工作台统一检索后共享，避免每个角色各自搜索带来的高延迟与高费用。
- 历史记录保存在本机，不做云同步；超过 40 条后最旧的会被裁剪。
- 讨论引擎依赖宿主进程，卸载插件或重启 Harness 时进行中的讨论会被取消并记为「已取消」。
