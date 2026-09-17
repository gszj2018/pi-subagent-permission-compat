# pi-subagent-permission-compat

[English](./README.md) | 简体中文

一个面向第三方子智能体（subagent）扩展的 [Pi Coding Agent](https://github.com/earendil-works/pi) 兼容性补丁包，提供两项彼此独立的能力：

1. **父会话环境兼容** —— 为根会话进程写入 `PI_SUBAGENT_PARENT_SESSION`，使继承该环境的子智能体子进程能够将权限询问回传到父会话。
2. **子智能体 cwd 防护** —— 检查子智能体工具调用输入中的 `cwd` 值，当某个值与当前工作目录不一致时，请求一次性批准。

**权限扩展兼容性**

- 本扩展用于兼容 [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system)：它会写入上述 `PI_SUBAGENT_PARENT_SESSION` 变量。详见其[子智能体集成文档](https://github.com/gotgenes/pi-packages/blob/main/packages/pi-permission-system/docs/subagent-integration.md)。
- 简言之，对于未自行遵守该约定的子智能体扩展，本扩展提供兼容性补丁。
- 本包不安装、不导入、也不查询该权限扩展，cwd 防护也不以其为前提。
- 只有该权限扩展自身已安装并启用时，这种配合才会实际生效。

两项能力始终开启且无需配置：本包不新增任何命令、工具、配置文件或持久化规则。

## 功能

### 1. 父会话环境兼容

在 `session_start` 时，如果当前进程是根会话，扩展会写入：

```text
PI_SUBAGENT_PARENT_SESSION=<当前会话 ID>
```

继承该环境的子进程据此可以定位父会话。

出现以下任一情况时跳过写入：

- 环境中已存在第三方子智能体标记，说明当前进程本身就是子智能体子进程。
- 环境中已声明父会话。

该值会在 `session_shutdown`（例如 `/new`、`/resume`、fork 或 `/reload`）时移除，避免会话切换后残留旧会话 ID。只有本扩展写入的值才会被移除；由其它组件设置或改写过的值保持不变。

确切的常量清单见[可识别的环境变量](#可识别的环境变量)。

### 2. 子智能体 cwd 防护

工具名中包含 `subagent`、`delegate`、`spawn` 或 `agent`（不区分大小写）的工具调用会被检查，输入树中任意位置发现的每个 `cwd` 字段都会被判定：

| `cwd` 值                               | 结果                                  |
|----------------------------------------|---------------------------------------|
| 缺失、`null` 或 `""`                   | 直接放行                              |
| 与当前目录完全相同的非空字符串         | 直接放行                              |
| 与当前目录不同的非空字符串             | 弹出批准提示（`Deny` / `Allow once`） |
| 其它类型（数字、布尔值、对象、数组等） | 弹出批准提示（`Deny` / `Allow once`） |
| 无法安全扫描的输入                     | 硬性拦截，用户无法批准                |

行为说明：

- 比较方式为原始字符串严格相等：工具输入与当前目录均不做 trim、归一化或改写。详见[注意事项与限制](#注意事项与限制)。
- 一次提示覆盖整个工具调用，并列出所有发现的 `cwd`，包括嵌套位置，例如 `$["tasks"][0]["cwd"]`。
- 批准仅对当次调用有效。不写入任何规则、不持久化，因此下次相同调用仍会再次询问。
- 只有精确选择 `Allow once` 才算批准。选择 `Deny`、取消提示、提示被关闭、返回未知响应或提示本身出错，都会拦截该调用。
- 没有交互 UI 时（print／JSON 模式，或无 UI 的子智能体），任何 ask 都会直接拦截而不弹窗。
- 批量或链式子智能体参数会作为一个调用整体判定：只要有一个 `cwd` 未获批准，整个调用即被拦截。

## 安装

作为 Pi 包安装：

```bash
# 从 npm 安装
pi install npm:pi-subagent-permission-compat

# 从本 GitHub 仓库安装
pi install git:github.com/gszj2018/pi-subagent-permission-compat
```

## 使用

安装后两项功能即自动生效，无需按会话启用，也无需任何配置。

- **父会话环境兼容** —— 无需配置。若同时使用权限扩展，参见上文说明。
- **子智能体 cwd 防护** —— 无需配置。在交互式会话中，若子智能体工具调用使用的工作目录不同，会逐次询问，由你选择 `Allow once` 或 `Deny`。

### 可识别的环境变量

确切的变量列表由 [`extensions/parent-session-env.ts`](./extensions/parent-session-env.ts) 中导出的常量定义：

- `THIRD_PARTY_SUBAGENT_ENV_HINTS` —— 第三方子智能体扩展在子进程内写入的标记，任一项存在即视为子智能体子进程并跳过写入。
- `SUBAGENT_PARENT_SESSION_ENV_CANDIDATES` —— 已携带父会话声明的变量，任一项存在时本扩展不改动环境。
- `PARENT_SESSION_ENV_VAR` —— 本扩展唯一写入的变量。

"存在"指变量已被定义：空字符串、空白、`"0"`、`"false"` 都视为已设置，因此既有声明始终优先，本扩展不会改写它们。

如果宿主提供的会话 ID 为空白等不可用值，扩展会给出警告通知且不写入变量，cwd 防护继续正常工作。

## 注意事项与限制

- cwd 防护**不是沙箱**。它只检查当次工具调用输入中可见的 `cwd` 字段，无法限制子智能体后续的行为。
- 工具名采用宽松匹配。名称中仅含 `agent` 的无关工具也可能被检查，而名称不含这些关键字的子智能体启动工具则不会被检查。
- 智能体配置中的默认工作目录、工具内部创建的 worktree、后续目录变更以及包装器内部的调用均不在覆盖范围内。
- 比较是原始字符串严格相等，而不是"相同真实目录"。大小写差异、尾部分隔符或重复分隔符、`.`／`..` 段、反斜杠与斜杠差异、首尾空白、相对与绝对写法都会触发提示而不会被自动放行；`link/..` 这类路径也不会被静默接受。若两侧字节完全相同，即使是非规范字符串也会放行。
- `cwd` 缺失、为 `null` 或 `""` 时按设计放行。这是便利性处理，不能证明调用方确实使用了当前目录。
- 无法安全扫描的输入——嵌套超过 10 层容器、不是普通 JSON 对象或数组的容器、异常的数组键或不可读成员——一律硬性拦截，用户无法批准。
- 没有交互 UI 时（print／JSON 模式或无 UI 的子智能体）不会弹出询问，而是直接拦截；本扩展没有其它批准途径。
- 批准是一次性的，且仅存在于本扩展内：不在会话内缓存、不向其它扩展共享。其它扩展仍可能拒绝同一个调用。
- 环境写入只覆盖继承环境的子进程（例如直接 `spawn`/`fork`）。替换过环境的进程、常驻守护进程、远程启动，以及共享同一 `process.env` 的进程内子智能体均不在覆盖范围内。

## 开发

```bash
# 安装依赖
npm install

# 运行测试
npm test

# 类型检查
npm run typecheck
```

如需在本地开发时直接加载扩展（无需打包），请在仓库根目录运行：

```bash
pi -e ./extensions/index.ts
```

项目使用 TypeScript 编写，测试采用 Node.js 内置测试运行器。

## 项目结构

```text
pi-subagent-permission-compat/
├── extensions/
│   ├── index.ts                   # 扩展入口（仅做组合装配）
│   ├── extension-meta.ts          # 公共扩展标识
│   ├── feature-parent-session.ts  # 父会话生命周期注册
│   ├── feature-cwd-guard.ts       # 工具调用注册与批准流程
│   ├── parent-session-env.ts      # 环境检测与 owned-value 清理
│   ├── cwd-ident.ts               # 工具名匹配
│   ├── cwd-inspection.ts          # cwd 收集
│   ├── cwd-guard.ts               # 逐值判定与拦截决策
│   ├── cwd-prompt.ts              # 提示格式化与 select 批准
│   └── diagnostics.ts             # 安全的值／错误展示辅助
└── tests/                         # 单元测试与集成测试
```

## 开源许可

[MIT](./LICENSE)
