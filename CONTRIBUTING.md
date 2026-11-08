# 贡献

本仓库使用 MIT License。贡献以 Developer Certificate of Origin 为准，不要求单独的贡献者许可协议。

## 提交

每条提交说明末尾加上：

```text
Signed-off-by: 姓名 <邮箱>
```

这表示你有权按 MIT 提交这些修改。可以用 `git commit -s` 生成这一行。

## 可以改哪里

| 位置 | 要求 |
|---|---|
| 文档和示例 | 能核对，不夸大安全效果 |
| 工具和 Provider | 声明权限；不把供应商分支写进 Loop |
| Loop、策略、沙箱、协议 | 先改对应 ADR 或需求，并补测试 |

`packages/core` 不能依赖 `packages/tools`。项目配置不能放宽用户的安全策略。

## 检查

```text
npm test
npm run lint
npm run eval
```

密钥不要写入提交。安全漏洞按 [SECURITY.md](SECURITY.md) 私下报告。
