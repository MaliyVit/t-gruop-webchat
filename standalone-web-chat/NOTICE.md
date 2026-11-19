# Third-party notices

## Runtime dependencies (installed by `npm ci`, shipped in the Docker image)

| Package | Version | License |
|---|---|---|
| fastify | 5.12.8 | MIT |
| @fastify/rate-limit | 10.3.0 | MIT |
| @fastify/static | 10.1.12 | MIT |
| @fastify/websocket | 11.3.7 | MIT |
| pg | 8.23.1 | MIT |

Their transitive dependencies (as locked in `package-lock.json`) are licensed MIT, BSD-3-Clause, ISC or
BlueOak-1.0.0. Each package carries its own license file inside `node_modules/`.

## Development-only dependencies (not shipped in the image)

TypeScript (Apache-2.0), `playwright-core` (Apache-2.0), `tsx`, `ws` and type packages (MIT).

## Container images

`node:22-alpine` and `postgres:17-alpine` are pulled from Docker Hub at build time and are not part of this
repository; see their upstream licenses.

## Icons

The arrow, minus and ellipsis glyphs in the widget are simple stroke paths that follow the
[Lucide](https://lucide.dev) icon set (ISC License; portions derived from Feather, MIT). No fonts, images or
other binary assets are bundled — the UI uses the system font stack.
