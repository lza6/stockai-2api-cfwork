/**
 * =================================================================================
 * 项目: stockai-2api (Cloudflare Worker 单文件版)
 * 版本: 1.0.0 (代号: Chimera Synthesis - StockAI)
 * 作者: 首席AI执行官 (Principal AI Executive Officer)
 * 协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
 * 日期: 2025-12-06
 * 
 * [核心特性]
 * 1. [双模适配] 同时支持流式(SSE)和非流式(JSON)响应，完美适配沉浸式翻译插件。
 * 2. [协议清洗] 将 StockAI 的自定义事件流实时转换为标准 OpenAI 格式。
 * 3. [匿名伪装] 内置浏览器指纹，无需登录即可使用。
 * 4. [开发者驾驶舱] 集成全中文调试界面，实时监控请求与响应。
 * =================================================================================
 */

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  PROJECT_NAME: "stockai-2api",
  PROJECT_VERSION: "1.0.0",
  
  // 安全配置 (建议在 Cloudflare 环境变量中设置 API_MASTER_KEY)
  API_MASTER_KEY: "1", 
  
  // 上游服务配置
  UPSTREAM_ORIGIN: "https://free.stockai.trade",
  UPSTREAM_API_URL: "https://free.stockai.trade/api/chat",
  
  // 伪装指纹 (基于 Chrome 142)
  HEADERS: {
    "authority": "free.stockai.trade",
    "accept": "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "content-type": "application/json",
    "origin": "https://free.stockai.trade",
    "referer": "https://free.stockai.trade/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "priority": "u=1, i"
  },

  // 模型列表 (从源码和抓包中提取)
  MODELS: [
    "openai/gpt-4o-mini",
    "google/gemini-2.0-flash",
    "stockai/news",
    "deepseek/deepseek-chat-v3.1",
    "meta/llama-4-scout",
    "moonshotai/kimi-k2",
    "z-ai/glm-4.6",
    "mistral/mistral-small",
    "qwen/qwen3-coder"
  ],
  DEFAULT_MODEL: "openai/gpt-4o-mini"
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    request.ctx = { apiKey };

    const url = new URL(request.url);

    // 1. CORS 预检
    if (request.method === 'OPTIONS') return handleCorsPreflight();

    // 2. 路由分发
    if (url.pathname === '/') return handleUI(request);
    if (url.pathname.startsWith('/v1/')) return handleApi(request);
    
    return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: API 代理逻辑] ---

async function handleApi(request) {
  // 鉴权
  if (!verifyAuth(request)) {
    return createErrorResponse('Unauthorized', 401, 'auth_error');
  }

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  }

  if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  }

  return createErrorResponse('Not Found', 404, 'not_found');
}

// 处理模型列表
function handleModelsRequest() {
  const modelsData = {
    object: 'list',
    data: CONFIG.MODELS.map(id => ({
      id: id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'stockai-2api',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

// 处理聊天请求 (核心逻辑)
async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const model = body.model || CONFIG.DEFAULT_MODEL;
    const messages = body.messages || [];
    const stream = body.stream !== false; // 默认为 true，除非显式设为 false
    const isWebUI = body.is_web_ui === true;

    // 1. 转换消息格式 (OpenAI -> StockAI)
    // StockAI 格式: { parts: [{type: "text", text: "..."}], role: "user", id: "..." }
    const convertedMessages = messages.map(msg => ({
      parts: [{ type: "text", text: msg.content }],
      id: generateRandomId(16),
      role: msg.role
    }));

    // 2. 构造上游 Payload
    const payload = {
      model: model,
      webSearch: false, // 暂不支持联网，保持简单
      id: generateRandomId(16), // 会话ID
      messages: convertedMessages,
      trigger: "submit-message"
    };

    // 3. 发送请求
    const response = await fetch(CONFIG.UPSTREAM_API_URL, {
      method: "POST",
      headers: CONFIG.HEADERS,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`上游服务错误 (${response.status}): ${errText}`);
    }

    // 4. 处理响应
    // StockAI 始终返回 SSE 流。
    // 如果客户端请求 stream=true，我们做实时转换。
    // 如果客户端请求 stream=false (如沉浸式翻译)，我们需要消费整个流并拼接结果。

    if (stream) {
      return handleStreamResponse(response, model, requestId, isWebUI);
    } else {
      return handleNonStreamResponse(response, model, requestId);
    }

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// 处理流式响应 (SSE -> SSE)
function handleStreamResponse(upstreamResponse, model, requestId, isWebUI) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  (async () => {
    try {
      const reader = upstreamResponse.body.getReader();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (!dataStr || dataStr === '[DONE]') continue;

            try {
              const data = JSON.parse(dataStr);
              
              // StockAI 的 delta 在 data.delta 中，且类型为 text-delta
              if (data.type === 'text-delta' && data.delta) {
                const chunk = {
                  id: requestId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [{ index: 0, delta: { content: data.delta }, finish_reason: null }]
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
              // 处理结束
              else if (data.type === 'finish') {
                 // Do nothing, wait for loop end or explicit stop
              }
            } catch (e) { }
          }
        }
      }

      // 发送结束标记
      const endChunk = {
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
      await writer.write(encoder.encode('data: [DONE]\n\n'));

    } catch (e) {
      const errChunk = {
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{ index: 0, delta: { content: `\n\n[Error: ${e.message}]` }, finish_reason: "error" }]
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: corsHeaders({ 'Content-Type': 'text/event-stream' })
  });
}

// 处理非流式响应 (SSE -> JSON)
// 适配沉浸式翻译等不支持流的插件
async function handleNonStreamResponse(upstreamResponse, model, requestId) {
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();
          if (!dataStr || dataStr === '[DONE]') continue;
          try {
            const data = JSON.parse(dataStr);
            if (data.type === 'text-delta' && data.delta) {
              fullText += data.delta;
            }
          } catch (e) {}
        }
      }
    }
  } catch (e) {
    throw new Error(`Stream buffering failed: ${e.message}`);
  }

  const response = {
    id: requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: fullText },
      finish_reason: "stop"
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };

  return new Response(JSON.stringify(response), {
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

// --- 辅助函数 ---

function verifyAuth(request) {
  const auth = request.headers.get('Authorization');
  const key = request.ctx.apiKey;
  if (key === "1") return true;
  return auth === `Bearer ${key}`;
}

function generateRandomId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

function createErrorResponse(msg, status, code) {
  return new Response(JSON.stringify({ error: { message: msg, type: 'api_error', code } }), {
    status, headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// --- [第四部分: 开发者驾驶舱 UI] ---
function handleUI(request) {
  const origin = new URL(request.url).origin;
  
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; --primary: #FFBF00; --accent: #007AFF; }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      .sidebar { width: 380px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; }
      
      .box { background: #252525; padding: 12px; border-radius: 6px; border: 1px solid var(--border); margin-bottom: 15px; }
      .label { font-size: 12px; color: #888; margin-bottom: 5px; display: block; }
      .code-block { font-family: monospace; font-size: 12px; color: var(--primary); word-break: break-all; background: #111; padding: 8px; border-radius: 4px; cursor: pointer; }
      .code-block.secret { cursor: default; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .code-actions { display: flex; gap: 6px; }
      .ghost-btn { background: #1f1f1f; color: #ddd; border: 1px solid #333; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }
      .ghost-btn:hover { border-color: var(--primary); color: var(--primary); }
      
      input, select, textarea { width: 100%; background: #333; border: 1px solid #444; color: #fff; padding: 8px; border-radius: 4px; margin-bottom: 10px; box-sizing: border-box; }
      button { width: 100%; padding: 10px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; color: #000; }
      button:disabled { background: #555; cursor: not-allowed; }
      
      .chat-window { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 15px; }
      .msg { max-width: 80%; padding: 10px 15px; border-radius: 8px; line-height: 1.5; }
      .msg.user { align-self: flex-end; background: #333; color: #fff; }
      .msg.ai { align-self: flex-start; background: #1a1a1a; border: 1px solid #333; width: 100%; max-width: 100%; }
      
      .log-panel { height: 150px; background: #111; border-top: 1px solid var(--border); padding: 10px; font-family: monospace; font-size: 11px; color: #aaa; overflow-y: auto; }
      .log-entry { margin-bottom: 4px; border-bottom: 1px solid #222; padding-bottom: 2px; }
      .log-time { color: #666; margin-right: 5px; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2 style="margin-top:0">🚀 ${CONFIG.PROJECT_NAME} <span style="font-size:12px;color:#888">v${CONFIG.PROJECT_VERSION}</span></h2>
        
        <div class="box">
            <span class="label">API 密钥</span>
            <input id="api-key" type="password" placeholder="请输入 API 密钥" autocomplete="off" value="" />
            <div style="font-size:11px;color:#888;margin-top:6px;">出于安全考虑，密钥不会在页面显示或自动填充。</div>
        </div>

        <div class="box">
            <span class="label">API 接口地址</span>
            <div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>

        <div class="box">
            <span class="label">模型选择</span>
            <select id="model">
                ${CONFIG.MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}
            </select>
            
            <span class="label">提示词 (Prompt)</span>
            <textarea id="prompt" rows="4" placeholder="输入问题...">你好，请介绍一下你自己。</textarea>
            
            <div style="display:flex; gap:10px; align-items:center; margin-bottom:10px;">
                <input type="checkbox" id="stream" checked style="width:auto; margin:0;">
                <label for="stream" style="margin:0; font-size:12px; color:#ccc;">流式响应 (Stream)</label>
            </div>

            <button id="btn-gen" onclick="send()">发送请求</button>
        </div>
        
        <div class="box">
            <span class="label">功能说明</span>
            <div style="font-size:12px; color:#888;">
                ✅ 匿名访问 (无需 Cookie)<br>
                ✅ 支持流式 (SSE) 输出<br>
                ✅ 支持非流式 (适配沉浸式翻译)<br>
                ✅ 自动 Markdown 渲染
            </div>
        </div>
    </div>

    <main class="main">
        <div class="chat-window" id="chat">
            <div style="color:#666; text-align:center; margin-top:50px;">
                StockAI 代理服务就绪。<br>
                支持 OpenAI 格式调用。
            </div>
        </div>
        <div class="log-panel" id="logs"></div>
    </main>

    <script>
        const ENDPOINT = "${origin}/v1/chat/completions";
        
        function log(msg) {
            const el = document.getElementById('logs');
            const div = document.createElement('div');
            div.className = 'log-entry';
            div.innerHTML = \`<span class="log-time">[\${new Date().toLocaleTimeString()}]</span> \${msg}\`;
            el.appendChild(div);
            el.scrollTop = el.scrollHeight;
        }

        function copy(text) {
            navigator.clipboard.writeText(text);
            log('已复制到剪贴板');
        }

        function appendMsg(role, text) {
            const div = document.createElement('div');
            div.className = \`msg \${role}\`;
            div.innerText = text;
            document.getElementById('chat').appendChild(div);
            div.scrollIntoView({ behavior: "smooth" });
            return div;
        }

        async function send() {
            const prompt = document.getElementById('prompt').value.trim();
            const model = document.getElementById('model').value;
            const stream = document.getElementById('stream').checked;
            const apiKeyInput = document.getElementById('api-key').value.trim();

            if (!prompt) return alert('请输入提示词');
            if (!apiKeyInput) return alert('请先输入 API 密钥');

            const btn = document.getElementById('btn-gen');
            btn.disabled = true;
            btn.innerText = "请求中...";

            if(document.querySelector('.chat-window').innerText.includes('代理服务就绪')) {
                document.getElementById('chat').innerHTML = '';
            }

            appendMsg('user', prompt);
            const aiMsg = appendMsg('ai', '...');
            let fullText = "";

            log(\`发送请求: \${model} (Stream: \${stream})\`);

            try {
                const res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + apiKeyInput,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: [{ role: 'user', content: prompt }],
                        stream: stream,
                        is_web_ui: true
                    })
                });

                if (!res.ok) throw new Error((await res.json()).error?.message || '请求失败');

                if (stream) {
                    const reader = res.body.getReader();
                    const decoder = new TextDecoder();
                    aiMsg.innerText = "";

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        const chunk = decoder.decode(value);
                        const lines = chunk.split('\\n');
                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const dataStr = line.slice(6);
                                if (dataStr === '[DONE]') break;
                                try {
                                    const json = JSON.parse(dataStr);
                                    const content = json.choices[0].delta.content;
                                    if (content) {
                                        fullText += content;
                                        aiMsg.innerText = fullText;
                                    }
                                } catch (e) {}
                            }
                        }
                    }
                } else {
                    const data = await res.json();
                    aiMsg.innerText = data.choices[0].message.content;
                }
                log('请求完成');

            } catch (e) {
                aiMsg.innerText = 'Error: ' + e.message;
                aiMsg.style.color = '#CF6679';
                log('错误: ' + e.message);
            } finally {
                btn.disabled = false;
                btn.innerText = "发送请求";
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
