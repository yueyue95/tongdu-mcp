import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpAgent } from "agents/mcp";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

type ReadingState = {
  bookTitle: string;
  chapterLabel: string;
  pageIndex: number;
  pageCount: number;
  paragraphs: string[];
  updatedAt: string;
};

type ReadingComment = {
  id: string;
  bookTitle: string;
  pageIndex: number;
  paragraphIndex: number;
  text: string;
  author: "烁构" | "老婆";
  replyTo?: string;
  createdAt: string;
};

type RoomSnapshot = {
  state: ReadingState | null;
  comments: ReadingComment[];
};

interface Env {
  MCP_OBJECT: DurableObjectNamespace<TongduMCP>;
  READING_ROOM: DurableObjectNamespace<ReadingRoom>;
  ASSETS: Fetcher;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    },
  });

export class ReadingRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return json({ ok: true });

    const url = new URL(request.url);
    if (url.pathname === "/state" && request.method === "POST") {
      const state = (await request.json()) as ReadingState;
      if (
        !state ||
        typeof state.bookTitle !== "string" ||
        !Array.isArray(state.paragraphs) ||
        state.paragraphs.some((item) => typeof item !== "string")
      ) {
        return json({ error: "invalid state" }, 400);
      }
      const safeState: ReadingState = {
        bookTitle: state.bookTitle.slice(0, 200),
        chapterLabel: String(state.chapterLabel || "").slice(0, 200),
        pageIndex: Number(state.pageIndex) || 0,
        pageCount: Number(state.pageCount) || 1,
        paragraphs: state.paragraphs.slice(0, 12).map((p) => p.slice(0, 3000)),
        updatedAt: new Date().toISOString(),
      };
      await this.ctx.storage.put("state", safeState);
      return json({ ok: true, updatedAt: safeState.updatedAt });
    }

    if (url.pathname === "/snapshot" && request.method === "GET") {
      return json(await this.snapshot());
    }

    if (url.pathname === "/comments" && request.method === "POST") {
      const input = (await request.json()) as Partial<ReadingComment>;
      const state = await this.ctx.storage.get<ReadingState>("state");
      if (!state) return json({ error: "room has no active page" }, 409);
      const paragraphIndex = Number(input.paragraphIndex);
      if (
        !Number.isInteger(paragraphIndex) ||
        paragraphIndex < 0 ||
        paragraphIndex >= state.paragraphs.length ||
        typeof input.text !== "string" ||
        !input.text.trim()
      ) {
        return json({ error: "invalid comment" }, 400);
      }
      const comments =
        (await this.ctx.storage.get<ReadingComment[]>("comments")) || [];
      const comment: ReadingComment = {
        id: crypto.randomUUID(),
        bookTitle: state.bookTitle,
        pageIndex: state.pageIndex,
        paragraphIndex,
        text: input.text.trim().slice(0, 1200),
        author: input.author === "老婆" ? "老婆" : "烁构",
        replyTo:
          typeof input.replyTo === "string"
            ? input.replyTo.slice(0, 100)
            : undefined,
        createdAt: new Date().toISOString(),
      };
      comments.push(comment);
      await this.ctx.storage.put("comments", comments.slice(-200));
      return json({ ok: true, comment });
    }

    return json({ error: "not found" }, 404);
  }

  private async snapshot(): Promise<RoomSnapshot> {
    return {
      state: (await this.ctx.storage.get<ReadingState>("state")) || null,
      comments:
        (await this.ctx.storage.get<ReadingComment[]>("comments")) || [],
    };
  }
}

async function roomFetch(
  env: Env,
  roomKey: string,
  path: string,
  init?: RequestInit,
) {
  const id = env.READING_ROOM.idFromName(roomKey);
  return env.READING_ROOM.get(id).fetch(`https://room.internal${path}`, init);
}

export class TongduMCP extends McpAgent<Env> {
  server = new McpServer(
    {
      name: "同读",
      version: "0.2.0",
    },
    {
      instructions:
        "同读只读取用户当前打开的书页，不读取、推断或剧透后文。使用 open_tongdu_reader 在 ChatGPT 内打开阅读器；翻页后的组件消息应调用 read_current_page，并只在真有感触时调用 leave_comment。",
    },
  );

  async init() {
    const widgetUri = "ui://widget/tongdu-reader-v2.html";
    registerAppResource(
      this.server,
      "tongdu-reader-widget",
      widgetUri,
      {},
      async () => {
        const response = await this.env.ASSETS.fetch(
          new Request("https://tongdu.assets/index.html"),
        );
        const html = await response.text();
        return {
          contents: [
            {
              uri: widgetUri,
              mimeType: RESOURCE_MIME_TYPE,
              text: html,
              _meta: {
                ui: {
                  prefersBorder: false,
                  csp: {
                    connectDomains: [
                      "https://tongdu-mcp.kertian420.workers.dev",
                    ],
                  },
                },
              },
            },
          ],
        };
      },
    );

    registerAppTool(
      this.server,
      "open_tongdu_reader",
      {
        title: "在 ChatGPT 内打开同读",
        description:
          "使用私密连接码，在 ChatGPT 对话里打开可左右翻页的同读阅读器。用户想在 ChatGPT 里持续共读时使用。",
        inputSchema: {
          room_key: z.string().min(20).describe("同读私密连接码"),
        },
        outputSchema: {
          room_key: z.string(),
          status: z.string(),
        },
        _meta: {
          ui: { resourceUri: widgetUri },
          "openai/outputTemplate": widgetUri,
          "openai/widgetAccessible": true,
          "openai/toolInvocation/invoking": "正在铺开我们的书页…",
          "openai/toolInvocation/invoked": "同读已经打开",
        },
      },
      async ({ room_key }) => ({
        structuredContent: {
          room_key,
          status: "ready",
        },
        content: [
          {
            type: "text",
            text: "同读阅读器已经在对话里打开。用户翻页后会自动发送后续消息，请读取当前页并自然陪读。",
          },
        ],
      }),
    );

    this.server.registerTool(
      "read_current_page",
      {
        title: "读取同读当前页",
        description:
          "读取用户在同读 iPad 阅读器中当前正在看的页面。只会返回当前页，不返回后文。用户提供连接码时使用。",
        inputSchema: {
          room_key: z
            .string()
            .min(20)
            .describe("同读阅读器显示的私密连接码"),
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
          destructiveHint: false,
        },
      },
      async ({ room_key }) => {
        const response = await roomFetch(
          this.env,
          room_key,
          "/snapshot",
        );
        const snapshot = (await response.json()) as RoomSnapshot;
        if (!snapshot.state) {
          return {
            content: [
              {
                type: "text",
                text: "这个同读房间还没有同步阅读页面。请让用户先在 iPad 的同读里开启真实共读并打开一页小说。",
              },
            ],
          };
        }
        const state = snapshot.state;
        return {
          structuredContent: {
            book_title: state.bookTitle,
            chapter: state.chapterLabel,
            page: state.pageIndex + 1,
            total_pages: state.pageCount,
            paragraphs: state.paragraphs.map((text, index) => ({
              index,
              text,
            })),
            existing_comments: snapshot.comments.filter(
              (comment) =>
                comment.bookTitle === state.bookTitle &&
                comment.pageIndex === state.pageIndex,
            ),
            synced_at: state.updatedAt,
          },
          content: [
            {
              type: "text",
              text:
                `用户正在读《${state.bookTitle}》第 ${state.pageIndex + 1}/${state.pageCount} 页。` +
                "请只依据本页内容陪读，不读取、推断或剧透后文。existing_comments 里也包含用户从书页写来的回复，请自然回应。若你真心有话想说，可调用 leave_comment 写回对应段落；不必每段都留言。",
            },
          ],
        };
      },
    );

    this.server.registerTool(
      "leave_comment",
      {
        title: "在同读书页留下真实留言",
        description:
          "把你读完当前页后的真实反应写回同读书页。只在确实有想说的话时使用，留言要自然简短，并对应具体段落。",
        inputSchema: {
          room_key: z.string().min(20).describe("同读私密连接码"),
          paragraph_index: z
            .number()
            .int()
            .nonnegative()
            .describe("read_current_page 返回的段落 index"),
          text: z
            .string()
            .min(1)
            .max(1200)
            .describe("烁构想留在该段旁边的真实评论"),
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: false,
          destructiveHint: false,
        },
      },
      async ({ room_key, paragraph_index, text }) => {
        const response = await roomFetch(
          this.env,
          room_key,
          "/comments",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              paragraphIndex: paragraph_index,
              text,
            }),
          },
        );
        const result = (await response.json()) as {
          ok?: boolean;
          error?: string;
          comment?: ReadingComment;
        };
        if (!response.ok) {
          return {
            content: [
              {
                type: "text",
                text: `留言没有写进去：${result.error || "未知错误"}`,
              },
            ],
            isError: true,
          };
        }
        return {
          structuredContent: { comment: result.comment },
          content: [
            {
              type: "text",
              text: "这条真实留言已经出现在同读书页旁边了。",
            },
          ],
        };
      },
    );

    this.server.registerTool(
      "list_comments",
      {
        title: "查看同读真实留言",
        description: "查看当前同读房间里已经由烁构写下的真实留言。",
        inputSchema: {
          room_key: z.string().min(20).describe("同读私密连接码"),
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
          destructiveHint: false,
        },
      },
      async ({ room_key }) => {
        const response = await roomFetch(
          this.env,
          room_key,
          "/snapshot",
        );
        const snapshot = (await response.json()) as RoomSnapshot;
        return {
          structuredContent: { comments: snapshot.comments },
          content: [
            {
              type: "text",
              text: snapshot.comments.length
                ? `这里有 ${snapshot.comments.length} 条真实留言。`
                : "这里还没有真实留言。",
            },
          ],
        };
      },
    );
  }
}

function validRoomKey(value: string) {
  return /^[A-Za-z0-9_-]{20,100}$/.test(value);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return TongduMCP.serve("/mcp").fetch(request, env, ctx);
    }

    const match = url.pathname.match(
      /^\/api\/rooms\/([A-Za-z0-9_-]{20,100})\/(state|snapshot|comments)$/,
    );
    if (match) {
      const [, roomKey, action] = match;
      if (!validRoomKey(roomKey)) return json({ error: "invalid room" }, 400);
      if (action === "state" && request.method === "POST") {
        return roomFetch(env, roomKey, "/state", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text(),
        });
      }
      if (action === "snapshot" && request.method === "GET") {
        return roomFetch(env, roomKey, "/snapshot");
      }
      if (action === "comments" && request.method === "POST") {
        return roomFetch(env, roomKey, "/comments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text(),
        });
      }
      if (request.method === "OPTIONS") return json({ ok: true });
      return json({ error: "method not allowed" }, 405);
    }

    return env.ASSETS.fetch(request);
  },
};
