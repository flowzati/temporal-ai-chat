import http from 'http';
import url from 'url';
import * as db from '../utils/db';

/**
 * 设置 CORS 响应头
 */
function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * 处理 OPTIONS 预检请求
 */
function handleOptions(res: http.ServerResponse): void {
  res.statusCode = 204;
  res.end();
}

/**
 * 获取会话列表
 */
function handleListSessions(res: http.ServerResponse): void {
  try {
    const items = db.listSessions(200);
    res.statusCode = 200;
    res.end(JSON.stringify({ items }));
  } catch (error: any) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: error?.message ?? 'Internal server error' }));
  }
}

/**
 * 获取指定会话的消息列表
 */
function handleGetMessages(pathname: string, res: http.ServerResponse): void {
  try {
    const parts = pathname.split('/');
    const sessionId = parts[3] || '';
    
    if (!sessionId) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Missing sessionId' }));
      return;
    }
    
    const items = db.getMessages(sessionId, 1000);
    res.statusCode = 200;
    res.end(JSON.stringify({ items }));
  } catch (error: any) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: error?.message ?? 'Internal server error' }));
  }
}

/**
 * 处理 404 错误
 */
function handleNotFound(res: http.ServerResponse): void {
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found' }));
}

/**
 * HTTP 路由处理器
 */
export function createHttpRequestHandler(): http.RequestListener {
  return (req, res) => {
    const parsed = req?.url ? url.parse(req.url, true) : { pathname: '' as string, query: {} as any };
    const method = req?.method ?? 'GET';
    const pathname = parsed.pathname ?? '';

    // 设置 CORS 响应头
    setCorsHeaders(res);

    // 处理 OPTIONS 预检请求
    if (method === 'OPTIONS') {
      handleOptions(res);
      return;
    }

    // 路由分发
    if (method === 'GET' && pathname === '/api/sessions') {
      handleListSessions(res);
      return;
    }

    if (method === 'GET' && pathname.startsWith('/api/sessions/') && pathname.endsWith('/messages')) {
      handleGetMessages(pathname, res);
      return;
    }

    // 404 处理
    handleNotFound(res);
  };
}

