# Maintenance

| Change | Update |
|--------|--------|
| SDK dependency | `package.json` + lock + this START-HERE note |
| Spooled API usage | `server/server.mjs` + START-HERE |
| Frontend IA / stable DOM ids | `public/` + START-HERE Frontend section |
| Response headers / CSP / anything loaded by `public/index.html` | `server/guards.mjs` + `test/http.test.mjs` + START-HERE HTTP surface; no inline script, style or handlers in `public/` |
| Image build / labels / CI image steps | `Dockerfile` + `.github/workflows/ci.yml` + `test/release-metadata.test.mjs` + DEPLOY.md |
