import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';

const execAsync = promisify(exec);

/**
 * Dynamic helper to locate the brain directory
 */
async function getBrainDir() {
  const home = process.env.HOME || '/home/ubuntu';
  const newPath = path.join(home, '.gemini/antigravity/brain');
  const oldPath = path.join(home, '.gemini/antigravity-cli/brain');
  try {
    await fs.access(newPath);
    return newPath;
  } catch {
    try {
      await fs.access(oldPath);
      return oldPath;
    } catch {
      return newPath;
    }
  }
}

/**
 * Gets the latest modified directory in brain folder
 */
async function getLatestConversationId() {
  const brainDir = await getBrainDir();
  try {
    const files = await fs.readdir(brainDir);
    const dirs = [];
    for (const file of files) {
      if (file.startsWith('.')) continue;
      const fullPath = path.join(brainDir, file);
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        dirs.push({ id: file, mtime: stat.mtimeMs });
      }
    }
    if (dirs.length === 0) return null;
    dirs.sort((a, b) => b.mtime - a.mtime);
    return dirs[0].id;
  } catch (err) {
    console.error('Error finding latest conversation:', err);
    return null;
  }
}

/**
 * Reads and parses transcript JSONL file
 */
async function getTranscript(conversationId) {
  if (!conversationId) return [];
  const brainDir = await getBrainDir();
  const transcriptPath = path.join(
    brainDir,
    conversationId,
    '.system_generated/logs/transcript.jsonl'
  );
  try {
    const data = await fs.readFile(transcriptPath, 'utf8');
    return data
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line));
  } catch (err) {
    console.error(`Error reading transcript for ${conversationId}:`, err);
    return [];
  }
}

/**
 * Simple token estimation based on character count and content type.
 */
function estimateTokens(text) {
  if (!text) return 0;
  // If text contains Vietnamese characters, estimate higher token count per character
  const isVietnamese = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(text);
  const divider = isVietnamese ? 2.0 : 3.8;
  return Math.ceil(text.length / divider);
}

/**
 * Parses conversation steps and aggregates token counts.
 */
function processTokens(steps) {
  let inputTokens = 0;
  let outputTokens = 0;
  let toolTokens = 0;

  steps.forEach(step => {
    let stepTokenCount = 0;
    
    // Estimate based on step content
    if (step.content) {
      stepTokenCount += estimateTokens(step.content);
    }
    
    // Estimate based on tool calls (if any)
    if (step.tool_calls && step.tool_calls.length > 0) {
      step.tool_calls.forEach(tc => {
        stepTokenCount += estimateTokens(tc.name);
        if (tc.args) {
          stepTokenCount += estimateTokens(JSON.stringify(tc.args));
        }
      });
    }

    step.tokens = stepTokenCount;

    // Classify step tokens
    if (step.type === 'USER_INPUT') {
      inputTokens += stepTokenCount;
    } else if (step.type === 'PLANNER_RESPONSE') {
      outputTokens += stepTokenCount;
    } else {
      // System, history, or tool responses
      if (step.type === 'CONVERSATION_HISTORY' || step.type === 'SYSTEM') {
        inputTokens += stepTokenCount;
      } else {
        toolTokens += stepTokenCount;
      }
    }
  });

  return {
    input: inputTokens,
    output: outputTokens,
    tool: toolTokens,
    total: inputTokens + outputTokens + toolTokens
  };
}

/**
 * Runs a prompt using the Antigravity CLI (agy)
 * @param {string} prompt - The task description or query for the agent
 * @param {object} options - Optional parameters
 * @param {boolean} options.dangerouslySkipPermissions - If true, passes --dangerously-skip-permissions
 * @param {string} options.conversationId - Resume a specific conversation ID
 * @param {string} options.agyPath - Path to the agy binary
 * @returns {Promise<{stdout: string, stderr: string, success: boolean, conversationId?: string, steps?: Array, tokens?: object, code?: number}>}
 */
export async function runAgy(prompt, options = {}) {
  const {
    dangerouslySkipPermissions = true,
    conversationId = null,
    sandbox = false,
    agyPath = 'agy'
  } = options;

  // Escape double quotes in prompt to prevent shell breakout
  const escapedPrompt = prompt.replace(/"/g, '\\"');
  let cmd = `export PATH="$HOME/.local/bin:$PATH" && ${agyPath} --print "${escapedPrompt}"`;
  
  if (dangerouslySkipPermissions) {
    cmd += ' --dangerously-skip-permissions';
  }
  if (conversationId) {
    cmd += ` --conversation "${conversationId}"`;
  }
  if (sandbox) {
    cmd += ' --sandbox';
  }

  // Redirect stdin from /dev/null to prevent hanging in non-interactive/daemon environments
  cmd += ' < /dev/null';

  try {
    const { stdout, stderr } = await execAsync(cmd);
    
    // Find the conversation ID and load the step transcript
    const activeConvId = conversationId || await getLatestConversationId();
    const steps = await getTranscript(activeConvId);
    const tokenUsage = processTokens(steps);

    return { 
      stdout: stdout.trim(), 
      stderr: stderr.trim(), 
      success: true,
      conversationId: activeConvId,
      steps: steps,
      tokens: tokenUsage
    };
  } catch (error) {
    const activeConvId = conversationId || await getLatestConversationId();
    const steps = await getTranscript(activeConvId);
    const tokenUsage = processTokens(steps);
    return { 
      stdout: error.stdout ? error.stdout.trim() : '', 
      stderr: error.stderr ? error.stderr.trim() : error.message, 
      success: false,
      conversationId: activeConvId,
      steps: steps,
      tokens: tokenUsage,
      code: error.code
    };
  }
}

/**
 * Retrieves details (transcript, output, tokens) of an existing conversation
 * @param {string} conversationId - The conversation ID to fetch
 * @returns {Promise<object|null>}
 */
export async function getConversationDetails(conversationId) {
  if (!conversationId) return null;
  const brainDir = await getBrainDir();
  const folderPath = path.join(brainDir, conversationId);
  try {
    await fs.access(folderPath);
  } catch {
    return null;
  }

  const steps = await getTranscript(conversationId);
  if (steps.length === 0) {
    return null;
  }
  const tokenUsage = processTokens(steps);
  const plannerResponses = steps.filter(s => s.type === 'PLANNER_RESPONSE');
  const output = plannerResponses.length > 0 ? plannerResponses[plannerResponses.length - 1].content : '';

  return {
    success: true,
    conversationId,
    steps,
    tokens: tokenUsage,
    output: output
  };
}

// If run directly from terminal
const isDirectRun = process.argv[1] && (
  process.argv[1] === import.meta.filename || 
  process.argv[1].endsWith('node_wrapper.js')
);

if (isDirectRun) {
  const prompt = process.argv[2];
  if (!prompt) {
    console.error('Usage: node node_wrapper.js "your prompt here"');
    process.exit(1);
  }
  
  console.log(`Running agy with prompt: "${prompt}"...`);
  const result = await runAgy(prompt);
  console.log('\n--- OUTPUT ---');
  console.log(result.stdout || '(No Output)');
  if (result.conversationId) {
    console.log(`\n--- CONVERSATION ID: ${result.conversationId} ---`);
    console.log(`Steps executed: ${result.steps ? result.steps.length : 0}`);
  }
  if (result.stderr) {
    console.log('\n--- ERROR/WARNINGS ---');
    console.error(result.stderr);
  }
  process.exit(result.success ? 0 : 1);
}
