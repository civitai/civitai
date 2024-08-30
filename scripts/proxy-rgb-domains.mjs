import redbird from 'redbird';

const proxy = redbird({
  port: 80,
  xfwd: false,
  bunyan: false,
  ssl: {
    port: 443,
  },
});
const proxyColors = ['red', 'green', 'blue'];
for (const color of proxyColors) {
  proxy.register(`civitai-dev.${color}`, 'http://localhost:3000', {
    ssl: {
      key: `scripts/certs/${color}-key.pem`,
      cert: `scripts/certs/${color}-cert.pem`,
    },
  });
  console.log(`${color} proxy:`, `https://civitai-dev.${color}`);
}
