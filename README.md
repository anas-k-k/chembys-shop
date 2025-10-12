# Playwright tests for chembys.shop

This folder contains a minimal Playwright test that navigates to `https://chembys.shop/login`.

Prerequisites

- Node.js (16+)

Install and run (PowerShell):

```powershell
npm init -y; npm i -D @playwright/test; npx playwright install
npx playwright test tests/login.spec.js
```

The test will open a browser and assert the URL contains `/login`. Adjust as needed.
