import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { runAgy, getConversationDetails } from './wrappers/node_wrapper.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3999;
const SECRET_KEY = process.env.AGY_BRIDGE_SECRET || 'antigravity-bridge-secret-123';

// Authentication Middleware
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-bridge-secret'] || req.query.secret;
  if (!apiKey || apiKey !== SECRET_KEY) {
    return res.status(401).json({ 
      success: false, 
      error: 'Unauthorized: Invalid or missing X-Bridge-Secret header or secret query parameter' 
    });
  }
  next();
};

// POST Endpoint to execute agy tasks
app.post('/api/agent', authenticate, async (req, res) => {
  const { prompt, dangerouslySkipPermissions = true, conversationId = null, sandbox = false } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ 
      success: false, 
      error: 'Bad Request: "prompt" is required and must be a string' 
    });
  }

  try {
    console.log(`[API] Received task: "${prompt}"`);
    const result = await runAgy(prompt, { dangerouslySkipPermissions, conversationId, sandbox });
    
    if (result.success) {
      res.json({
        success: true,
        output: result.stdout,
        conversationId: result.conversationId,
        steps: result.steps,
        tokens: result.tokens,
        error: result.stderr || null
      });
    } else {
      res.status(500).json({
        success: false,
        output: result.stdout,
        conversationId: result.conversationId,
        steps: result.steps,
        tokens: result.tokens,
        error: result.stderr,
        code: result.code
      });
    }
  } catch (err) {
    console.error(`[API] Execution error:`, err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// GET Endpoint to retrieve conversation details
app.get('/api/agent/conversation/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const details = await getConversationDetails(id);
    if (!details) {
      return res.status(404).json({
        success: false,
        error: `Conversation with ID ${id} not found`
      });
    }
    res.json(details);
  } catch (err) {
    console.error(`[API] Error fetching conversation details for ${id}:`, err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Helper to get Gemini Proxy credentials dynamically from models.json
function getProxyConfig() {
  try {
    const configPath = path.join(os.homedir(), '.pi/agent/models.json');
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const provider = data.providers?.['cloudflare-gemini'];
      if (provider) {
        return {
          baseUrl: provider.baseUrl.replace(/\/proxy\/v1beta$/, ''),
          apiKey: provider.apiKey
        };
      }
    }
  } catch (err) {
    console.error('Error reading models.json:', err);
  }
  return {
    baseUrl: process.env.PROXY_BASE_URL || 'https://gemini-proxy.makexyzfun.workers.dev',
    apiKey: process.env.PROXY_API_KEY || 'cloudflare-gemini-proxy-Secret@123'
  };
}

// GET Endpoint to retrieve model quota and reset times
app.get('/api/model-quota', authenticate, async (req, res) => {
  try {
    const config = getProxyConfig();
    const statusUrl = `${config.baseUrl}/proxy/status`;
    
    let proxyData = null;
    try {
      const response = await fetch(statusUrl, {
        method: 'GET',
        headers: {
          'X-Proxy-Secret': config.apiKey
        }
      });
      if (response.ok) {
        proxyData = await response.json();
      }
    } catch (err) {
      console.warn('Could not fetch proxy status, using fallback values:', err.message);
    }

    // Calculate Pacific Time midnight reset countdown
    const now = new Date();
    const pacificStr = now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
    const pacificDate = new Date(pacificStr);
    const midnightPacific = new Date(pacificDate);
    midnightPacific.setHours(24, 0, 0, 0);
    const diffMs = midnightPacific.getTime() - pacificDate.getTime();
    const diffHours = Math.max(0, Math.floor(diffMs / (3600 * 1000)));
    const diffMinutes = Math.max(0, Math.floor((diffMs % (3600 * 1000)) / (60 * 1000)));
    
    const refreshTextPacific = `Refreshes in ${diffHours} hour${diffHours !== 1 ? 's' : ''}, ${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''}`;
    
    // Custom reset time for Claude models (mocked countdown)
    const claudeHours = 4;
    const claudeMinutes = 59;
    const refreshTextClaude = `Refreshes in ${claudeHours} hours, ${claudeMinutes} minutes`;

    // Define models and estimate their remaining quotas
    const modelsQuota = [
      {
        id: 'gemini-3.5-flash-medium',
        name: 'Gemini 3.5 Flash (Medium)',
        remainingPct: 80,
        refreshText: refreshTextPacific
      },
      {
        id: 'gemini-3.5-flash-high',
        name: 'Gemini 3.5 Flash (High)',
        remainingPct: 70,
        refreshText: refreshTextPacific
      },
      {
        id: 'gemini-3.5-flash-low',
        name: 'Gemini 3.5 Flash (Low)',
        remainingPct: 90,
        refreshText: refreshTextPacific
      },
      {
        id: 'gemini-3.1-pro-low',
        name: 'Gemini 3.1 Pro (Low)',
        remainingPct: 95,
        refreshText: refreshTextPacific
      },
      {
        id: 'gemini-3.1-pro-high',
        name: 'Gemini 3.1 Pro (High)',
        remainingPct: 90,
        refreshText: refreshTextPacific
      },
      {
        id: 'claude-sonnet-4.6',
        name: 'Claude Sonnet 4.6 (Thinking)',
        remainingPct: 100,
        refreshText: refreshTextClaude
      },
      {
        id: 'claude-opus-4.6',
        name: 'Claude Opus 4.6 (Thinking)',
        remainingPct: 100,
        refreshText: refreshTextClaude
      },
      {
        id: 'gpt-oss-120b',
        name: 'GPT-OSS 120B (Medium)',
        remainingPct: 100,
        refreshText: refreshTextClaude
      }
    ];

    // Adjust Google models dynamically based on actual proxy usage if available
    if (proxyData && proxyData.keys) {
      let totalUsedToday = 0;
      let totalKeys = proxyData.keys.length;
      proxyData.keys.forEach(k => {
        totalUsedToday += k.requests_today || 0;
      });
      
      const avgUsed = totalUsedToday / (totalKeys || 1);
      
      modelsQuota[0].remainingPct = Math.max(10, Math.round(100 - (avgUsed * 1.5))); // Medium
      modelsQuota[1].remainingPct = Math.max(10, Math.round(100 - (avgUsed * 2.0))); // High
      modelsQuota[2].remainingPct = Math.max(10, Math.round(100 - (avgUsed * 0.8))); // Low
      modelsQuota[3].remainingPct = Math.max(5, Math.round(100 - (avgUsed * 0.5)));  // Low Pro
      modelsQuota[4].remainingPct = Math.max(5, Math.round(100 - (avgUsed * 0.9)));  // High Pro
    }

    res.json({
      success: true,
      quotas: modelsQuota
    });
  } catch (err) {
    console.error('Error generating model quota:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Verification Endpoint for Playground login
app.get('/api/verify', authenticate, (req, res) => {
  res.json({ success: true, message: 'Authenticated successfully' });
});

// Simple Healthcheck Endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'antigravity-bridge-api' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[AGY Bridge API] Server is running on http://0.0.0.0:${PORT}`);
  console.log(`[AGY Bridge API] Authentication: ${SECRET_KEY === 'antigravity-bridge-secret-123' ? 'Using DEFAULT secret (change in production via AGY_BRIDGE_SECRET)' : 'Using CUSTOM secret'}`);
});
