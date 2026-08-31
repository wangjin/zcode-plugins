# zcode-local-dev

ZCode 本地开发插件市场仓库：集中托管自研 ZCode 插件，并通过根目录的 `marketplace.json` 作为一个"个人插件市场"直接被 ZCode 客户端加载。

## 仓库结构

```
.
├── marketplace.json          # 市场清单（市场名、插件列表、版本与分类）
└── plugins/
    └── zcode-metrics/        # 插件：本地网页仪表盘，实时统计 ZCode 会话的模型输出速度
        ├── .zcode-plugin/plugin.json   # 插件清单（名称、版本、userConfig）
        ├── hooks/                      # Hook 定义与保活脚本（SessionStart / UserPromptSubmit / Stop）
        ├── dashboard/                  # 零依赖 Node 收集器 + SSE 网页仪表盘
        ├── test/                       # node --test 单元测试
        └── README.md                   # 插件详细文档
```

## 已收录插件

| 插件 | 版本 | 说明 |
| --- | --- | --- |
| [zcode-metrics](plugins/zcode-metrics/README.md) | 0.4.0 | 本地网页仪表盘，实时显示各会话的模型输出速度（tok/s）：多会话并行统计与按会话过滤、近 7 天历史趋势、模型对比、缓存命中分析。零依赖本地收集器，仅监听 `127.0.0.1`。 |

各插件的能力细节、设计要点与已知限制见其自带 README。

## 安装（作为本地市场）

1. 打开 ZCode **设置 → 插件**。
2. 右上角 **创建 → 添加插件市场**，选择本仓库根目录（含 `marketplace.json` 的目录）。
3. 在 **个人** 分段找到目标插件，点 **安装** 并启用。
4. 部分插件依赖 Hook 在会话启动时快照生效，安装后请**新建一个 session** 再验证。

## 开发

### 目录约定

- 每个插件一个目录：`plugins/<name>/`，内含 `.zcode-plugin/plugin.json` 清单；
- 新增插件后，在根目录 `marketplace.json` 的 `plugins[]` 中登记 `name / source / description / version / category / tags`，三者版本号需与插件清单一致。

### 测试

```bash
cd plugins/zcode-metrics && node --test "test/*.test.mjs"
```

### 本地调试

插件运行时数据默认落在 `~/.zcode/plugin-data/<plugin-name>/`（如 zcode-metrics 的 `port.json`、`server.log`、`history.jsonl`），删除该目录即完成数据清理；对 ZCode 本体零侵入。

## License

MIT
