/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  async rewrites() {
    return [{ source: '/', destination: '/app.html' }];
  }
};
module.exports = nextConfig;
