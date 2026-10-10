/** Static export: the Fastify server serves ./out and answers /api/*. */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },
  ...(process.env.NODE_ENV === "production"
    ? {}
    : {
        async rewrites() {
          return [{ source: "/:path(api|branding)/:rest*", destination: "http://127.0.0.1:4100/:path/:rest*" }];
        },
      }),
};

export default nextConfig;
