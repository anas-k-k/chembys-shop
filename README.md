# Playwright tests for chembys.shop

This folder contains a minimal Playwright test that navigates to `https://chembys.shop/login`.

Usage notes:

- To run tests against a custom base URL, run:

- Set the base URL interactively and run tests:

  npm run test:with-baseurl

  This runs `npm run set-baseurl` which prompts for a Base URL (default: `https://chembys.shop`), writes it to a `.env` file, then runs `playwright test`.

- Or run the prompt alone to only set the base URL:

  npm run set-baseurl

The Playwright config reads BASE_URL from the `.env` file and falls back to `https://chembys.shop`.

Prerequisites

- Node.js (16+)

Install and run (PowerShell):

```powershell
npm init -y; npm i -D @playwright/test; npx playwright install
npx playwright test tests/login.spec.js
```

The test will open a browser and assert the URL contains `/login`. Adjust as needed.
