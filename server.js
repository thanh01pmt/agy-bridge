import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { runAgy, getConversationDetails, listConversations } from './wrappers/node_wrapper.js';

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

// GET Endpoint to list recent conversations
app.get('/api/agent/conversations', authenticate, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const list = await listConversations(limit);
    res.json({ success: true, conversations: list });
  } catch (err) {
    console.error('[API] Error listing conversations:', err);
    res.status(500).json({ success: false, error: err.message });
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

    // Fetch and correlate exact proxy usage data
    const config = getProxyConfig();
    let exactUsage = {
      supported: true,
      calls: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedTokens: 0,
      totalCost: 0,
      stepsMatched: 0
    };

    try {
      const steps = details.steps || [];
      if (steps.length > 0) {
        const timestamps = steps
          .map(s => s.created_at)
          .filter(Boolean)
          .map(t => new Date(t).getTime());
        
        if (timestamps.length > 0) {
          const minTime = Math.min(...timestamps);
          const maxTime = Math.max(...timestamps);
          
          // Buffer time window by 45 seconds to cover latency
          const startTime = new Date(minTime - 45000).toISOString();
          const endTime = new Date(maxTime + 45000).toISOString();
          
          const callsUrl = `${config.baseUrl}/proxy/api-calls?startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}&limit=1000`;
          const response = await fetch(callsUrl, {
            headers: {
              'X-Proxy-Secret': config.apiKey
            }
          });
          
          if (response.ok) {
            const result = await response.json();
            if (result.success && result.calls) {
              // API calls from proxy are ordered newest to oldest, reverse to chronological
              const proxyCalls = result.calls.slice().reverse();
              
              // Helper to map modelId to price
              const getModelPrice = (modelId) => {
                const id = modelId.toLowerCase();
                if (id.includes('pro')) {
                  // Gemini Pro rates: $1.25 / 1M input, $5.00 / 1M output
                  return { input: 1.25 / 1000000, output: 5.00 / 1000000 };
                } else if (id.includes('flash')) {
                  // Gemini Flash rates: $0.075 / 1M input, $0.30 / 1M output
                  return { input: 0.075 / 1000000, output: 0.30 / 1000000 };
                }
                return { input: 0, output: 0 };
              };

              const matchedCallIds = new Set();
              
              // Match proxy calls to steps based on timestamp proximity
              for (const step of steps) {
                if (step.source === 'MODEL' || step.type === 'PLANNER_RESPONSE') {
                  const stepTime = new Date(step.created_at).getTime();
                  
                  let closestCall = null;
                  let minDiff = Infinity;
                  
                  for (const call of proxyCalls) {
                    if (matchedCallIds.has(call.id)) continue;
                    
                    const callTime = new Date(call.timestamp).getTime();
                    const diff = Math.abs(callTime - stepTime);
                    
                    // Match within 60 seconds
                    if (diff < 60000 && diff < minDiff) {
                      minDiff = diff;
                      closestCall = call;
                    }
                  }
                  
                  if (closestCall) {
                    matchedCallIds.add(closestCall.id);
                    const pricing = getModelPrice(closestCall.model_id);
                    const cost = (closestCall.input_tokens * pricing.input) + (closestCall.output_tokens * pricing.output);
                    
                    step.exactUsage = {
                      model: closestCall.model_id,
                      inputTokens: closestCall.input_tokens,
                      outputTokens: closestCall.output_tokens,
                      cachedTokens: closestCall.cached_tokens,
                      cost: cost,
                      matchedAt: closestCall.timestamp
                    };
                    
                    exactUsage.stepsMatched++;
                  }
                }
              }
              
              // Accumulate totals for all proxy calls inside the session window
              for (const call of proxyCalls) {
                const pricing = getModelPrice(call.model_id);
                const cost = (call.input_tokens * pricing.input) + (call.output_tokens * pricing.output);
                
                exactUsage.calls.push({
                  id: call.id,
                  model: call.model_id,
                  inputTokens: call.input_tokens,
                  outputTokens: call.output_tokens,
                  cachedTokens: call.cached_tokens,
                  cost: cost,
                  timestamp: call.timestamp,
                  matched: matchedCallIds.has(call.id)
                });
                
                exactUsage.totalInputTokens += call.input_tokens;
                exactUsage.totalOutputTokens += call.output_tokens;
                exactUsage.totalCachedTokens += call.cached_tokens;
                exactUsage.totalCost += cost;
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[API] Failed to correlate exact proxy usage:', err.message);
      exactUsage.supported = false;
      exactUsage.error = err.message;
    }

    details.exactUsage = exactUsage;
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
    const modelsUrl = `${config.baseUrl}/proxy/models`;
    
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

    let proxyModels = null;
    try {
      const response = await fetch(modelsUrl, {
        method: 'GET',
        headers: {
          'X-Proxy-Secret': config.apiKey
        }
      });
      if (response.ok) {
        proxyModels = await response.json();
      }
    } catch (err) {
      console.warn('Could not fetch proxy models, using fallback values:', err.message);
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
    
    const refreshTextPacific = `Refreshes in ${diffHours}h ${diffMinutes}m`;
    
    // Custom reset time for Claude models (mocked countdown)
    const claudeHours = 4;
    const claudeMinutes = 59;
    const refreshTextClaude = `Refreshes in ${claudeHours}h ${claudeMinutes}m`;

    let modelsQuota = [];
    if (proxyModels && (proxyModels.free_models || proxyModels.paid_only)) {
      const freeList = (proxyModels.free_models || []).map(m => typeof m === 'string' ? { id: m, name: m } : m);
      const paidList = (proxyModels.paid_only || []).map(m => typeof m === 'string' ? { id: m, name: m } : m);
      const allModels = [...freeList, ...paidList];

      modelsQuota = allModels.map(m => {
        let remainingPct = 100;
        if (proxyData && proxyData.keys) {
          const totalKeys = proxyData.keys.length;
          const coolingKeys = proxyData.keys.filter(k => {
            const mState = k.state?.model_states?.[m.id];
            return mState && mState.status === 'cooling';
          }).length;
          remainingPct = Math.max(0, Math.round(((totalKeys - coolingKeys) / (totalKeys || 1)) * 100));
        }

        let refText = refreshTextPacific;
        if (m.id && (m.id.startsWith('claude-') || m.id.startsWith('gpt-'))) {
          refText = refreshTextClaude;
        }

        return {
          id: m.id || '',
          name: m.name || m.id || '',
          remainingPct: remainingPct,
          refreshText: refText
        };
      });
    } else {
      // Fallback to estimated list if proxy models fetch failed
      modelsQuota = [
        {
          id: 'gemini-3.5-flash',
          name: 'Gemini 3.5 Flash',
          remainingPct: 80,
          refreshText: refreshTextPacific
        },
        {
          id: 'gemini-3.1-flash-lite',
          name: 'Gemini 3.1 Flash Lite',
          remainingPct: 90,
          refreshText: refreshTextPacific
        },
        {
          id: 'gemini-2.5-flash',
          name: 'Gemini 2.5 Flash',
          remainingPct: 75,
          refreshText: refreshTextPacific
        },
        {
          id: 'gemini-2.5-flash-lite',
          name: 'Gemini 2.5 Flash Lite',
          remainingPct: 85,
          refreshText: refreshTextPacific
        },
        {
          id: 'gemini-2.5-pro',
          name: 'Gemini 2.5 Pro',
          remainingPct: 95,
          refreshText: refreshTextPacific
        },
        {
          id: 'gemini-3.1-pro-preview',
          name: 'Gemini 3.1 Pro (Preview)',
          remainingPct: 90,
          refreshText: refreshTextPacific
        },
        {
          id: 'gemini-3.1-flash-live-preview',
          name: 'Gemini 3.1 Flash Live (Preview)',
          remainingPct: 85,
          refreshText: refreshTextPacific
        },
        {
          id: 'gemini-3-flash-preview',
          name: 'Gemini 3 Flash (Preview)',
          remainingPct: 80,
          refreshText: refreshTextPacific
        },
        {
          id: 'gemma-4-31b-it',
          name: 'Gemma 4 31B IT',
          remainingPct: 95,
          refreshText: refreshTextPacific
        },
        {
          id: 'gemma-4-26b-a4b-it',
          name: 'Gemma 4 26B A4B IT',
          remainingPct: 95,
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
        
        modelsQuota.forEach(m => {
          if (m.id === 'gemini-3.5-flash') {
            m.remainingPct = Math.max(10, Math.round(100 - (avgUsed * 1.5)));
          } else if (m.id === 'gemini-3.1-pro-preview') {
            m.remainingPct = Math.max(5, Math.round(100 - (avgUsed * 0.9)));
          }
        });
      }
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
