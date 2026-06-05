// src/lib/router.js
'use strict';

class Router {
  constructor() {
    this._routes = [];
  }

  _add(method, path, handler) {
    const keys = [];
    const src = path.replace(/:([^/]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
    this._routes.push({ method, re: new RegExp(`^${src}$`), keys, handler });
  }

  get(path, handler)    { this._add('GET',    path, handler); }
  post(path, handler)   { this._add('POST',   path, handler); }
  delete(path, handler) { this._add('DELETE', path, handler); }

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    for (const route of this._routes) {
      if (route.method !== req.method) continue;
      const m = url.pathname.match(route.re);
      if (!m) continue;
      req.params = Object.fromEntries(route.keys.map((k, i) => [k, m[i + 1]]));
      req.query  = Object.fromEntries(url.searchParams);
      await route.handler(req, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }
}

module.exports = { Router };
