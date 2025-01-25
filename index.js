#!/usr/bin/env node

//
// xgpt.js
// A Node.js CLI to chat with GPT, packaged via "pkg" into a single binary.
// Reads config from ~/.config/xgpt/xgpt.env if present.
//
// Features:
//   - Normal mode: streams tokens in real time (with axios + streaming)
//   - Markdown mode: spinner + prints entire response as Markdown
//   - Commands: /ns, /nsm, /quit
//   - CLI options: --apikey, --markdown
//   - After building with "pkg", place the binary in /usr/local/bin or similar.
//
// Usage:
//   ./xgpt --apikey YOUR_KEY "Hello"
//   or set API_KEY in ~/.config/xgpt/xgpt.env
//   or set --markdown to start in Markdown mode
//

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Command } from 'commander';
import readline from 'node:readline';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import dotenv from 'dotenv';     // <-- static import for dotenv
import axios from 'axios';       // <-- replaced node-fetch with axios

// ----------------------------------------------------------------------------
// 1) Load environment variables from ~/.config/xgpt/xgpt.env if it exists
// ----------------------------------------------------------------------------
const configDir = path.join(os.homedir(), '.config', 'xgpt');
const configFile = path.join(configDir, 'xgpt.env');

// Use dotenv.config() if the file exists
if (fs.existsSync(configFile)) {
  dotenv.config({ path: configFile });
}

// ----------------------------------------------------------------------------
// 2) Configure "marked" to render Markdown nicely in the terminal
// ----------------------------------------------------------------------------
marked.setOptions({
  renderer: new TerminalRenderer()
});

// ----------------------------------------------------------------------------
// 3) Set up Commander for CLI arguments
// ----------------------------------------------------------------------------
const program = new Command();
program
  .option('--apikey <apikey>', 'Your OpenAI API key')
  .option('--markdown', 'Start in Markdown mode')
  .argument('[prompt]', 'Initial prompt to start the conversation')
  .parse(process.argv);

const options = program.opts();
const initialPrompt = program.args[0];

// ----------------------------------------------------------------------------
// 4) Resolve the API key (priority: config file -> env -> CLI -> none)
// ----------------------------------------------------------------------------
const apiKey = process.env.API_KEY || options.apikey;
if (!apiKey) {
  console.error(
    "Error: No API key provided. Please set API_KEY in ~/.config/xgpt/xgpt.env or pass --apikey."
  );
  process.exit(1);
}

// ----------------------------------------------------------------------------
// 5) Resolve the model (fallback to gpt-4 if not specified)
// ----------------------------------------------------------------------------
const model = process.env.MODEL || 'gpt-4';

// ----------------------------------------------------------------------------
// 6) Determine if we start in Markdown mode from CLI
// ----------------------------------------------------------------------------
let isMarkdownMode = !!options.markdown;

// ----------------------------------------------------------------------------
// 7) Create a readline interface for interactive usage
// ----------------------------------------------------------------------------
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// We'll keep the conversation messages in memory
let messages = [];

// ----------------------------------------------------------------------------
// Spinner for "Loading..." in Markdown mode
// ----------------------------------------------------------------------------
let spinnerInterval = null;
function startSpinner() {
  const spinnerChars = ['|', '/', '-', '\\'];
  let i = 0;
  spinnerInterval = setInterval(() => {
    process.stdout.write(`\r${spinnerChars[i++ % spinnerChars.length]} Loading...`);
  }, 100);
}

function stopSpinner() {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
    process.stdout.write('\r'); // clear spinner line
  }
}

// ----------------------------------------------------------------------------
// Helper: reset the conversation for a new session
// ----------------------------------------------------------------------------
function resetConversation(markdownMode = false) {
  messages = [];
  isMarkdownMode = markdownMode;
  console.log(`\n--- Started a new session in ${isMarkdownMode ? 'Markdown' : 'Normal'} mode ---\n`);
}

// ----------------------------------------------------------------------------
// chatWithGPT: Normal mode (streaming tokens, using axios + Node.js streams)
// ----------------------------------------------------------------------------
async function chatWithGPTStream(userPrompt) {
  messages.push({ role: 'user', content: userPrompt });

  // Make a streaming request with axios
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model,
      messages,
      stream: true
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      responseType: 'stream' // essential for streaming
    }
  );

  process.stdout.write('\nAssistant: ');
  let fullMessage = '';

  // We'll wrap the stream reading in a Promise so we can "await" it
  await new Promise((resolve, reject) => {
    response.data.on('data', (chunk) => {
      const chunkStr = chunk.toString('utf8');
      // Same logic: look for "data: ..." lines
      const lines = chunkStr.split('\n').filter((line) => line.trim().startsWith('data: '));
      for (const line of lines) {
        const jsonStr = line.replace(/^data: /, '');
        if (jsonStr === '[DONE]') {
          // done streaming
          break;
        }
        try {
          const parsed = JSON.parse(jsonStr);
          const token = parsed.choices?.[0]?.delta?.content || '';
          if (token) {
            process.stdout.write(token);
            fullMessage += token;
          }
        } catch {
          // ignore parse errors for partial lines
        }
      }
    });

    response.data.on('end', () => {
      // End of streaming
      process.stdout.write('\n\n');
      messages.push({ role: 'assistant', content: fullMessage });
      resolve();
    });

    response.data.on('error', (err) => {
      reject(err);
    });
  });
}

// ----------------------------------------------------------------------------
// chatWithGPT: Markdown mode (non-streaming, spinner-based, simpler axios call)
// ----------------------------------------------------------------------------
async function chatWithGPTMarkdown(userPrompt) {
  messages.push({ role: 'user', content: userPrompt });

  startSpinner(); // spin while we wait

  let data;
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model, messages },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        }
      }
    );
    data = response.data;
  } finally {
    stopSpinner();
  }

  const assistantMessage = data.choices[0].message.content;
  const rendered = marked(assistantMessage);

  console.log('Assistant (Markdown):\n');
  console.log(rendered, '\n');

  messages.push({ role: 'assistant', content: assistantMessage });
}

// ----------------------------------------------------------------------------
// Prompt loop: handles user commands (/ns, /nsm, /quit) or normal input
// ----------------------------------------------------------------------------
function promptLoop() {
  rl.question('You: ', async (input) => {
    // Empty line => exit
    if (!input) {
      console.log('Exiting...');
      process.exit(0);
    }

    // /quit => exit
    if (input.trim() === '/quit') {
      console.log('Quitting...');
      process.exit(0);
    }

    // /ns => new session in normal mode
    if (input.startsWith('/ns ')) {
      const newSessionMsg = input.slice(3).trim();
      resetConversation(false);
      if (newSessionMsg) {
        try {
          await chatWithGPTStream(newSessionMsg);
        } catch (err) {
          console.error('Error:', err.message);
        }
      }
    } else if (input.trim() === '/ns') {
      resetConversation(false);

    // /nsm => new session in markdown mode
    } else if (input.startsWith('/nsm ')) {
      const newSessionMsg = input.slice(4).trim();
      resetConversation(true);
      if (newSessionMsg) {
        try {
          await chatWithGPTMarkdown(newSessionMsg);
        } catch (err) {
          console.error('Error:', err.message);
        }
      }
    } else if (input.trim() === '/nsm') {
      resetConversation(true);

    } else {
      // Normal user message => use current mode
      try {
        if (isMarkdownMode) {
          await chatWithGPTMarkdown(input);
        } else {
          await chatWithGPTStream(input);
        }
      } catch (err) {
        console.error('Error:', err.message);
      }
    }

    // Loop again
    promptLoop();
  });
}

// ----------------------------------------------------------------------------
// Start
// ----------------------------------------------------------------------------
console.log(`=== ChatGPT CLI (${model}) ===`);
console.log(`Current mode: ${isMarkdownMode ? 'Markdown' : 'Normal'}\n`);
console.log(`Commands:
  /ns        -> new blank session (Normal mode)
  /ns <msg>  -> new Normal session with an initial message
  /nsm       -> new blank session (Markdown mode)
  /nsm <msg> -> new Markdown session with an initial message
  /quit      -> exit
`);
console.log('Press Enter (empty) or Ctrl+C to exit.\n');

(async function main() {
  if (initialPrompt) {
    try {
      if (isMarkdownMode) {
        await chatWithGPTMarkdown(initialPrompt);
      } else {
        await chatWithGPTStream(initialPrompt);
      }
    } catch (err) {
      console.error('Error:', err.message);
    }
  }
  promptLoop();
})();
