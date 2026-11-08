# RuHui Agent / 如辉 Agent

如辉 Agent 是一个开源、通用、可嵌入的 Agent 运行时，规范标识是 `pub.rh.agent`。模型负责提议下一步，运行时负责把这一步变成受约束、可恢复的执行。

版权人是广州如辉物联网科技有限公司。官网：https://www.rh.pub/

## 许可证

本项目使用 [MIT License](LICENSE)。你可以商用，也可以二次开发后闭源分发。再分发时保留版权声明和 MIT 许可文本。衍生产品不必开源。

商标不随许可证转让，见 [TRADEMARK.md](TRADEMARK.md)。专利声明见 [PATENTS.md](PATENTS.md)，它不增加开源义务。

## 当前状态

命令 `ruhui` 和 npm 包尚未发布。本仓库按 MIT 许可公开源码、配置 Schema、包骨架和测试。设计文档不在这个仓库里。不要把本仓库当作已经能完成笔记摘要的安装包。

如辉 Token API（https://api.rh.pub/）将来只是一个可选的模型地址，不是运行依赖。

## 开发

本地检查：

```text
npm ci
npm test
npm run lint
npm run eval
```

目标运行时是 Node.js 26.13.0 或更高版本。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请发到 [SECURITY.md](SECURITY.md) 中的邮箱，不要开公开 Issue。
