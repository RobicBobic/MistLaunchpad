const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function (app) {
  app.use(
    '/api/pump',
    createProxyMiddleware({
      target: 'https://frontend-api.pump.fun',
      changeOrigin: true,
      pathRewrite: { '^/api/pump': '' },
      on: {
        proxyReq: (proxyReq) => {
          // Strip origin so pump.fun doesn't reject the request
          proxyReq.removeHeader('origin');
          proxyReq.removeHeader('referer');
          proxyReq.setHeader('User-Agent', 'Mozilla/5.0');
        },
      },
    })
  );
};