# 会议笔记

这个目录用假模型离线读取两则笔记，并写出 `summary.md`。它不访问网络，也不需要 API 密钥。

仓库里的 `.git` 会把工作区抬到仓库根。下面的脚本先把笔记复制到临时目录，再调用 `ruhui`。摘要写在临时目录，不改仓库里的文件。`RUHUI_HOME` 放在这个临时工作区外面。

在仓库根目录先运行 `npm test`，编译完成后再执行：

```text
node examples/meeting-notes/run.mjs
```

输出先是 `doctor`：版本、工作区、模式 `plan`、沙箱 `path-jail`。接着用 `workspace-write` 跑任务。结束时打印摘要路径。`summary.md` 里应有 `2026-12-01`、`周宁` 和 `2 万元`。

如辉 Token API（https://api.rh.pub/）不是这个示例的依赖。
