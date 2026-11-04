"use strict";
/**
 * ask_chatgpt for JOYA AI and its hired sessions: the Joya ChatGPT broker's
 * stdio MCP server (chatgpt/chatgpt_mcp.py, installed by deploy/install-chatgpt.sh
 * at /usr/local/lib/joya-chatgpt). It hands a task to ChatGPT through the
 * broker's socket, only when the administrator asks for it (its description
 * says so); the one ChatGPT sign-in stays with the broker.
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_SCRIPT = "/usr/local/lib/joya-chatgpt/chatgpt_mcp.py";
const SERVER = "chatgpt";
const ALLOW = "mcp__" + SERVER;

/** {name, server, allow} or null when switched off (cfg.chatgpt_mcp === "") or not installed. */
function chatgptServer(cfg, caller, outDir) {
  const script = cfg && cfg.chatgpt_mcp !== undefined ? cfg.chatgpt_mcp : DEFAULT_SCRIPT;
  if (!script || !fs.existsSync(script)) return null;
  const python = fs.existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
  const env = { JOYA_CHATGPT_CALLER: String(caller || "joya-ai") };
  if (outDir) env.JOYA_CHATGPT_OUT = path.resolve(String(outDir));
  return { name: SERVER, server: { type: "stdio", command: python, args: ["-I", script], env }, allow: ALLOW };
}

module.exports = { chatgptServer, DEFAULT_SCRIPT, SERVER, ALLOW };
