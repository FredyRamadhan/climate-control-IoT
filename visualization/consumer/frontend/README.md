# AutoClimate frontend

React and TypeScript dashboard, built with Vite. Run `npm ci` and `npm run dev` from the parent consumer directory to start both Express and Vite. See the [project README](../README.md) for configuration, API details, production builds, and Docker deployment.

UI sources live in `src/`, and `public/` contains self-hosted fonts and the AC image. Development requests to `/api` are proxied to Express. Production output goes to `../dist/client` and is served by Express.
