#!/usr/bin/env node

//
// cgpt.mjs
// Node.js CLI to chat with GPT, with two modes:
//   1) Normal (streaming, no Markdown, no spinner)
//   2) Markdown (non-streaming, spinner animation, prints entire response at once)
//
// Commands:
//   /ns      -> start a new (blank) session in normal mode
//   /ns <m>  -> start new normal session with an initial message
//   /nsm     -> start a new (blank) session in markdown mode
//   /nsm <m> -> start new markdown session with an initial message
//   /quit    -> exit
//
// Command-line option:
//   --markdown -> start in markdown mode immediately
//
// Requirements:
//   - Node.js >= 18 for native fetch() + streaming reads.
//   - npm install commander dotenv marked marked-terminal
//   - .env file optional:
//       API_KEY=your_openai_api_key
//       MODEL=gpt-4
//     or pass --apikey <YOUR_KEY> at runtime
//

import dotenv from 'dotenv';
import { Command } from 'commander';
import readline from 'node:readline';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';

// -----------------------------------------------------------------------------
// 1) Load environment variables from .env if present
// -----------------------------------------------------------------------------
dotenv.config();

// -----------------------------------------------------------------------------
// 2) Configure "marked" to render Markdown nicely in the terminal
// -----------------------------------------------------------------------------
marked.setOptions({
  renderer: new TerminalRenderer()
});

// -----------------------------------------------------------------------------
// 3) Set up Commander for CLI
// -----------------------------------------------------------------------------
const program = new Command();
program
  .option('--apikey <apikey>', 'Your OpenAI API key')
  .option('--markdown', 'Start in Markdown mode')
  .argument('[prompt]', 'Initial prompt to start the conversation')
  .parse(process.argv);

const options = program.opts();
const initialPrompt = program.args[0];

// -----------------------------------------------------------------------------
// 4) Retrieve the API key
// -----------------------------------------------------------------------------
const apiKey = process.env.API_KEY || options.apikey;
if (!apiKey) {
  console.error("Error: No API key provided.\nPlease supply it via .env as 'API_KEY' or via --apikey.");
  process.exit(1);
}

// -----------------------------------------------------------------------------
// 5) Retrieve the model (fallback to gpt-4)
// -----------------------------------------------------------------------------
const model = process.env.MODEL || 'gpt-4';

// -----------------------------------------------------------------------------
// 6) Determine if we start in Markdown mode from the CLI flag
// -----------------------------------------------------------------------------
let isMarkdownMode = !!options.markdown;

// -----------------------------------------------------------------------------
// 7) Create a readline interface for interactive usage
// -----------------------------------------------------------------------------
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// We'll keep the conversation messages in memory
let messages = [];

// -----------------------------------------------------------------------------
// Helper: spinner animation for "Loading..." in Markdown mode
// -----------------------------------------------------------------------------
let spinnerInterval = null;
function startSpinner() {
  const spinnerChars = ['|', '/', '-', '\\'];
  let i = 0;
  // We write a spinner every 100ms
  spinnerInterval = setInterval(() => {
    process.stdout.write(`\r${spinnerChars[i++ % spinnerChars.length]} Loading...`);
  }, 100);
}
function stopSpinner() {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
    // Clear the spinner line
    process.stdout.write('\r');
  }
}

// -----------------------------------------------------------------------------
// Resets the conversation to start a new session (clears messages).
// Also sets the current mode (markdown or not).
// -----------------------------------------------------------------------------
function resetConversation(markdownMode = false) {
  messages = [];
  isMarkdownMode = markdownMode;
  console.log(`\n--- Started a new session in ${isMarkdownMode ? 'Markdown' : 'Normal'} mode ---\n`);
}

// -----------------------------------------------------------------------------
// chatWithGPT (Normal mode, streaming).
// -----------------------------------------------------------------------------
async function chatWithGPTStream(userPrompt) {
  messages.push({ role: 'user', content: userPrompt });

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    // Enable streaming
    body: JSON.stringify({ model, messages, stream: true }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`HTTP Error ${response.status}: ${errText}`);
  }

  process.stdout.write('\nAssistant: ');
  let fullMessage = '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n').filter((line) => line.trim().startsWith('data: '));
    for (const line of lines) {
      const jsonStr = line.replace(/^data: /, '');
      if (jsonStr === '[DONE]') {
        break;
      }
      try {
        const parsed = JSON.parse(jsonStr);
        const token = parsed.choices?.[0]?.delta?.content || '';
        if (token) {
          process.stdout.write(token);  // print streaming token
          fullMessage += token;
        }
      } catch {
        // ignore streaming parse errors
      }
    }
  }

  process.stdout.write('\n\n');
  // Store the assistant's message for context
  messages.push({ role: 'assistant', content: fullMessage });
}

// -----------------------------------------------------------------------------
// chatWithGPT (Markdown mode, no streaming).
// Shows a spinner while waiting, then prints entire response as Markdown.
// -----------------------------------------------------------------------------
async function chatWithGPTMarkdown(userPrompt) {
  messages.push({ role: 'user', content: userPrompt });

  startSpinner();  // start our spinner animation

  let data;
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      // Do NOT use streaming
      body: JSON.stringify({ model, messages }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP Error ${response.status}: ${errText}`);
    }

    data = await response.json();
  } finally {
    // Stop spinner whether success or error
    stopSpinner();
  }

  const assistantMessage = data.choices[0].message.content;

  // Render as Markdown
  const rendered = marked(assistantMessage);
  console.log('Assistant (Markdown):\n');
  console.log(rendered, '\n');

  // Store for context
  messages.push({ role: 'assistant', content: assistantMessage });
}

// -----------------------------------------------------------------------------
// Main prompt loop: handle commands (/ns, /nsm, /quit, etc.) or normal input
// -----------------------------------------------------------------------------
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
      // If user typed /ns plus a message
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
      // plain "/ns" with no message
      resetConversation(false);

    // /nsm => new session in markdown mode
    } else if (input.startsWith('/nsm ')) {
      // if user typed /nsm plus a message
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
      // plain "/nsm" with no message
      resetConversation(true);

    } else {
      // Normal user input => chat in current mode
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

    // Keep prompting
    promptLoop();
  });
}

// -----------------------------------------------------------------------------
// Start the CLI
// -----------------------------------------------------------------------------
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

// If there's an initial prompt from the CLI, handle it in the current mode
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
