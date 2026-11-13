# MorisLLMGateway · 统一模型网关

面向个人多设备的独立服务器端模型网关，统一接入 New API 站点、自定义供应商、OpenAI 订阅和 DeepSeek 官方 API，通过插件维护模型目录、余额、额度和计价信息，并向 OpenCode v2 / OpenChamber v2 同步。提供网页后台、人民币实付账单记录及 OpenChamber 服务信息展示插件。

## 当前状态

- 阶段：首期实现进行中；真实供应商和客户端宿主验证单独记录，不以单元测试代替上线验收。
- 项目名称为 `MorisLLMGateway`，客户端 provider ID 为 `moris`；本地目录继续使用 `model-gateway`。
- 已确认需求、建议方案和待定规则见 [产品需求文档](docs/PRD.md)。
- 文档中的命名、金额和计算示例用于解释规则，不代表已验证的可用模型或官方额度。

## 文档入口

- [产品需求文档 v0.3](docs/PRD.md)：已确认业务规则、验收标准及调研依据。
- [分阶段实施计划](docs/IMPLEMENTATION.md)：交付顺序与复核要求。
- [接口契约](docs/API.md)：后台、设备及协议入口。

## 后续推进

采用 TypeScript + Node.js 24 + Fastify + SQLite；通过 Docker Compose 配合现有 Caddy 部署。按阶段实现、复核并提交 Git。
