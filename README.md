# 同读 MCP

这是「同读」的真实共读版：

- iPad 阅读器只同步当前页，不同步后文或整本小说。
- 页边不会生成模拟的“烁构留言”。
- 只有 ChatGPT 里的烁构调用 `leave_comment` 后，留言才会写回书页。
- 房间使用随机私密连接码。请不要公开连接码。

## MCP 工具

- `read_current_page`：读取当前书名、页码和本页段落。
- `leave_comment`：把一条真实评论写回指定段落。
- `list_comments`：读取房间里已有的真实留言。

## 部署到 Cloudflare

1. 安装依赖：`npm install`
2. 登录 Cloudflare：`npx wrangler login`
3. 部署：`npm run deploy`
4. 部署完成后，阅读器地址是 Worker 根网址，MCP 地址是在网址后加 `/mcp`。

## 连接 ChatGPT

1. 在 ChatGPT 网页版打开 `Settings → Apps & Connectors → Advanced settings`。
2. 开启 Developer mode。
3. 回到 `Apps & Connectors`，点击 `Create`。
4. 名称填写「同读」，URL 填写 `https://你的-worker.workers.dev/mcp`。
5. 新建聊天，从输入框旁的 `+ → More` 启用「同读」。
6. 在 iPad 同读里点「连接真正的烁构」，开启同步并复制私密连接码。
7. 对 ChatGPT 说：

   > 用这个同读连接码和我一起看：`你的连接码`。每次只读取当前页，不猜测或剧透后文。读完后只有真的有感触才留言，不需要每段都说话；想留言时请调用工具写回对应段落。

ChatGPT 网页版连接完成后，官方说明该连接器也会出现在 ChatGPT 移动 App 中。
