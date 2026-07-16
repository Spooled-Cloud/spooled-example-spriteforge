# Findings

| ID | Sev | Summary | Status |
|----|-----|---------|--------|
| SF-01 | P3 | SDK pin lagged tip — resolved by bump to 1.0.39 | closed |
| SF-02 | P0 | SDK 1.0.26 `completeJob` omitted `leaseId` → backend 0.1.107 `409 LEASE_EXPIRED` → forge hangs | fixed in v1.0.15 |
| SF-03 | P1 | `package-lock.json` app version lagged `package.json` (`1.0.14` vs `1.0.15`) | fixed working tree |
| SF-04 | P3 | HTML/manifest referenced missing generated OG/PWA assets | fixed working tree |
| SF-05 | P3 | `/health` lacked app version/commit identity | fixed working tree |
