/**
 * 本地 CodeBuddy 抓包代理：把 dsh 的 chat/completions 请求转发到真实网关，
 * 同时把每个请求体与响应前 1KB 写入日志，用于诊断工具调用失败。
 * 用法：node cb-proxy.mjs 启动后监听 127.0.0.1:18080；
 * 把 llm-codebuddy.endpoint 指向 http://127.0.0.1:18080/v2/chat/completions
 * （适配器会把 endpoint 当作完整 URL 直接 POST，因此代理监听
 *  http://127.0.0.1:18080/v2/chat/completions 即可）。
 */
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'

const PORT = 18080
const UPSTREAM = 'https://copilot.tencent.com/v2/chat/completions'
const LOG = process.env.CB_PROXY_LOG ?? 'cb-proxy.log'

mkdirSync(LOG.replace(/[\\/][^\\/]+$/, ''), { recursive: true })

const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const entry = {
    at: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: req.headers,
    body: body.slice(0, 200_000),
  }
  appendFileSync(LOG, `\n\n### REQUEST ${entry.at}\n${JSON.stringify(entry, null, 2)}\n`)
  try {
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: req.headers.authorization ?? '',
        'x-user-id': req.headers['x-user-id'] ?? '',
        'x-domain': req.headers['x-domain'] ?? '',
        'user-agent': req.headers['user-agent'] ?? 'codebuddy-dsh',
        accept: 'text/event-stream',
      },
      body,
    })
    const text = await upstream.text()
    appendFileSync(LOG, `### RESPONSE ${upstream.status} ${new Date().toISOString()}\n${text.slice(0, 30_000)}\n`)
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'text/event-stream' })
    res.end(text)
  } catch (e) {
    appendFileSync(LOG, `### PROXY ERROR ${String(e)}\n`)
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ msg: `proxy error: ${String(e)}` }))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cb-proxy listening on http://127.0.0.1:${PORT} -> ${UPSTREAM}; log: ${LOG}`)
})