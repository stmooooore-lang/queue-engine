const { spawn, execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// HF Spaces requires port 7860
const PORT = 7860;
const LITELLM_PORT = 4000;
const LITELLM_HOST = '127.0.0.1';
const LITELLM_HEALTH_URL = `http://${LITELLM_HOST}:${LITELLM_PORT}/health/liveliness`;
const LITELLM_BASE_URL = `http://${LITELLM_HOST}:${LITELLM_PORT}/v1`;
const CONFIG_PATH = path.join(__dirname, 'cloud-config.yaml');

let litellmProcess = null;

// Create providers.json for Cline
function createProvidersJson() {
  const clineSettingsDir = path.join(os.homedir(), '.cline', 'data', 'settings');
  const providersPath = path.join(clineSettingsDir, 'providers.json');

  if (!fs.existsSync(clineSettingsDir)) {
    fs.mkdirSync(clineSettingsDir, { recursive: true });
  }

  const config = {
    version: 1,
    lastUsedProvider: 'openai-compatible',
    providers: {
      'openai-compatible': {
        settings: {
          provider: 'openai-compatible',
          apiKey: 'not-used-by-the-local-proxy',
          model: 'plexus-act',
          baseUrl: LITELLM_BASE_URL,
          headers: {}
        },
        updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        tokenSource: 'migration'
      }
    }
  };

  fs.writeFileSync(providersPath, JSON.stringify(config, null, 2));
  fs.chmodSync(providersPath, 0o600);
  console.log(`[server] Created providers.json at ${providersPath}`);
}

// Start LiteLLM proxy as child process
function startLiteLLM() {
  return new Promise((resolve, reject) => {
    console.log('[server] Starting LiteLLM proxy...');

    litellmProcess = spawn('litellm', [
      '--config', CONFIG_PATH,
      '--port', String(LITELLM_PORT),
      '--host', LITELLM_HOST,
      '--num_workers', '1'
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    litellmProcess.stdout.on('data', (data) => {
      console.log(`[litellm] ${data.toString().trim()}`);
    });

    litellmProcess.stderr.on('data', (data) => {
      console.error(`[litellm:err] ${data.toString().trim()}`);
    });

    litellmProcess.on('error', (err) => {
      console.error('[server] Failed to start LiteLLM:', err);
      reject(err);
    });

    litellmProcess.on('exit', (code, signal) => {
      console.log(`[server] LiteLLM exited with code ${code}, signal ${signal}`);
    });

    // Wait for health endpoint
    waitForHealth().then(resolve).catch(reject);
  });
}

// Poll LiteLLM health endpoint
function waitForHealth(maxAttempts = 40, intervalMs = 3000) {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    function check() {
      attempts++;
      http.get(LITELLM_HEALTH_URL, (res) => {
        if (res.statusCode === 200) {
          console.log(`[server] LiteLLM proxy is ready after ${attempts * (intervalMs / 1000)}s`);
          resolve();
        } else {
          if (attempts >= maxAttempts) {
            reject(new Error(`LiteLLM health check returned ${res.statusCode} after ${maxAttempts} attempts`));
          } else {
            setTimeout(check, intervalMs);
          }
        }
      }).on('error', (err) => {
        if (attempts >= maxAttempts) {
          reject(new Error(`LiteLLM did not come up after ${maxAttempts} attempts: ${err.message}`));
        } else {
          setTimeout(check, intervalMs);
        }
      });
    }

    // Initial delay before first check
    setTimeout(check, 5000);
  });
}

// Run Cline and extract the last run_result text
function runClineTest() {
  return new Promise((resolve, reject) => {
    const args = [
      '--cwd', process.cwd(),
      '-P', 'openai-compatible',
      '-m', 'plexus-act',
      '--compaction', 'off',
      '--json', 'скажи одно слово: привет'
    ];

    console.log('[server] Running cline with args:', args);

    execFile('cline', args, { timeout: 120000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[server] Cline error:', err.message);
        console.error('[server] Cline stderr:', stderr);
        reject(new Error(`Cline failed: ${err.message}\n${stderr}`));
        return;
      }

      console.log('[server] Cline stdout:', stdout);

      // Parse JSON lines, find last run_result
      const lines = stdout.trim().split('\n');
      let lastRunResult = null;

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'run_result') {
            lastRunResult = obj;
          }
        } catch (e) {
          // Ignore non-JSON lines
        }
      }

      if (lastRunResult && lastRunResult.text) {
        resolve({ answer: lastRunResult.text.trim() });
      } else {
        reject(new Error('No run_result found in Cline output'));
      }
    });
  });
}

// Main server
async function main() {
  try {
    // Create providers.json
    createProvidersJson();

    // Start LiteLLM
    await startLiteLLM();

    // Create HTTP server
    const server = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === '/' || req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      } else if (req.url === '/test') {
        try {
          const result = await runClineTest();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error('[server] /test error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });

    server.listen(PORT, () => {
      console.log(`[server] HTTP server listening on port ${PORT}`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      console.log('[server] SIGTERM received, shutting down...');
      if (litellmProcess) {
        litellmProcess.kill('SIGTERM');
      }
      server.close(() => process.exit(0));
    });

    process.on('SIGINT', () => {
      console.log('[server] SIGINT received, shutting down...');
      if (litellmProcess) {
        litellmProcess.kill('SIGTERM');
      }
      server.close(() => process.exit(0));
    });

  } catch (err) {
    console.error('[server] Fatal error:', err);
    process.exit(1);
  }
}

main();
