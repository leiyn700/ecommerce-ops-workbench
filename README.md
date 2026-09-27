# ecommerce-ops-workbench · 电商经营工作台

把「卖前定价、卖中内容、卖后复盘」装进一个工具箱的 WorkBuddy skill。

## 三个子工作台（经营闭环）

```
选品(外接 sourcing-review-workbench)
   ↓
定价 pricing/  →  卖前：成本倒推建议售价（x.9 尾数），五平台费率，18 品类
   ↓
内容 content/  →  卖中：带货短视频选题 + 八件交付包（分镜/口播稿/转发引导/置顶话术…）
   ↓
利润 (根目录)  →  卖后：千帆订单明细 → 分层利润（毛利/履约后/经营）→ 建议价与调价动作
   ↓
复盘结果反哺定价参数与内容选题，闭环
```

## 快速开始

- **利润工作台**：双击 `demo/` 下的单文件 HTML（或 `node scripts/build-workbench.js` 重新构建），导入千帆导出的包裹详情表即可，全程浏览器本地计算，不上传任何数据。
- **定价工作台**：打开 `pricing/assets/web/定价工作台.html`，填进价/运费/推广占比，自动倒推建议售价。
- **内容工作台**：AI 会话中触发（选题/脚本/置顶话术），依赖 ima 知识库检索脚本 `scripts/ima-api.cjs`（凭证放 `~/.config/ima/`）。

## 特性

- **零依赖**：利润与定价均为单文件 HTML，双击即用，无需登录
- **口径单一实现**：费率表、建议价、退款均摊只在 `assets/engine/` 一处定义
- **91 项回归测试**：`tests/` 下 `node tests/engine.test.js`、`node tests/workbench.test.js`
- **费率官方核实**：小红书/淘宝/拼多多为官方口径，抖音/快手为二手资料并带提醒标注

## 结构

```
├── SKILL.md              # 总入口：按意图路由三个子工作台 + 共享层数据流
├── assets/engine/        # 共享计算引擎（利润/建议价/费率/解析）
├── assets/web/           # 利润工作台 HTML 模板
├── scripts/              # build-workbench.js + ima-api.cjs
├── tests/                # 91 项回归测试
├── references/           # 核算口径 / 建议价规则 / 踩坑清单
├── pricing/              # 定价工作台
└── content/              # 带货短视频工作台
```

## License

MIT
