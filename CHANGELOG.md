# 变更记录

## 未发布

- 建立仓库工程基线：MIT 许可、架构测试、数据夹具和跨平台 CI。
- P0-1：核心类型覆盖 Session、Turn、Budget、ToolResult 和轨迹事件信封，`schemaVersion` 固定为 1。
- P0-2：轨迹追加前打码，半行丢弃，断号和未知 `schemaVersion` 拒绝恢复且不改写，死进程可以接管 `writer.lock`。
- P0-3：假 Provider 按脚本回放文本或工具调用，同一脚本两次结果相同，不访问网络。
- 运行时命令 `ruhui` 尚未提供。
