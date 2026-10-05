import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './browser-tests', timeout: 30000, workers: 1,
  use: { baseURL:'http://127.0.0.1:3100', browserName:'chromium', headless:true, ...(process.env.PW_CHANNEL ? { channel:process.env.PW_CHANNEL } : {}) },
  webServer: { command:'node server/index.js', port:3100, reuseExistingServer:false, env:{PORT:'3100'} },
});
