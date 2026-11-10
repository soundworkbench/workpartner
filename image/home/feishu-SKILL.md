---
name: feishu
description: 用本人身份处理飞书和飞书项目中的文档、表格、日程、消息、邮件、审批和任务，写操作前先确认。
---

# 飞书与飞书项目

先执行 `lark-cli auth status` 或 `meegle auth status`，确认当前账号和授权。未授权时按部署方提供的登录方式连接，等待本人完成；不索取、读取或展示令牌和应用密钥。不要把失败或空结果当作成功。

按任务读取同一固定版本的官方技能和 references：文档 lark-doc，表格 lark-sheets，多维表格 lark-base，日程 lark-calendar，消息 lark-im，邮件 lark-mail，审批 lark-approval，任务 lark-task，知识库 lark-wiki，云盘 lark-drive，通讯录 lark-contact，会议 lark-meeting，项目 meegle。仅使用部署方提供的 CLI，不自动升级或切换身份。

发消息、邮件、提交审批、删除或修改分享权限之前，展示具体对象、接收人、完整内容、附件和影响，并取得本人对本次操作的明确确认。优先使用预览或 `--dry-run`。CLI 返回高风险确认时，先取得本人确认，再按提示重试；不绕过确认。
