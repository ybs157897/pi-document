import express, { type Express, type Response } from 'express';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const policy = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self'", "connect-src 'self'",
  "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
].join('; ');

function headers(response: Response) {
  response.set({
    'Content-Security-Policy': policy,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
}

export function addManagementUi(app: Express, directory = resolve('dist/ui')) {
  app.use('/ui/assets', (_request, response, next) => { headers(response); next(); }, express.static(join(directory, 'assets'), {
    index: false, dotfiles: 'deny', immutable: true, maxAge: '1y', fallthrough: false,
  }));
  app.get(['/', '/ui', '/ui/'], async (_request, response) => {
    headers(response); response.set('Cache-Control', 'no-store');
    try {
      await access(join(directory, 'index.html'));
      response.sendFile(join(directory, 'index.html'));
    } catch {
      response.status(503).type('html').send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Pi Document</title><h1>管理界面尚未构建</h1><p>请在项目目录运行 <code>npm run build:ui</code>，然后刷新。A2A 服务仍可正常使用。</p></html>');
    }
  });
}
