"use strict";
/**
 * Minimal Telegram Bot API client.
 *
 * Used only at configuration time -- the agents themselves talk to Telegram
 * through the Python runtime. The point of these calls is to fail loudly in the
 * dashboard rather than quietly in a systemd unit at 2am: a mistyped token, a
 * bot that was never added to the group, or a group that is not a forum are all
 * things we can detect before the agent is created.
 *
 * Tokens are never logged and never stored here; they pass through to the
 * privileged helper, which writes them to the agent's 0600 environment file.
 */

const API = "https://api.telegram.org/bot";
const TIMEOUT_MS = 10000;

const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,60}$/;

function looksLikeToken(token) {
  return typeof token === "string" && TOKEN_RE.test(token.trim());
}

async function call(token, method, params) {
  if (!looksLikeToken(token)) throw new Error("Malformed bot token.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API + token + "/" + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params || {}),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error("Telegram did not respond in time.");
    throw new Error("Could not reach Telegram: " + e.message);
  }
  clearTimeout(timer);

  let body;
  try {
    body = await res.json();
  } catch (_) {
    throw new Error("Telegram returned a response we could not read.");
  }
  if (!body.ok) {
    // description is Telegram's own text; surface it, it is usually precise.
    throw new Error(body.description || "Telegram rejected the request.");
  }
  return body.result;
}

/**
 * Confirm the token works and return the bot's identity.
 * This is the single most valuable check: a wrong token is the most common
 * reason a newly created agent never answers.
 */
async function getMe(token) {
  const me = await call(token, "getMe");
  return {
    id: me.id,
    username: me.username,
    name: me.first_name,
    canJoinGroups: me.can_join_groups === true,
    canReadAllGroupMessages: me.can_read_all_group_messages === true,
    supportsInline: me.supports_inline_queries === true,
  };
}

/**
 * Inspect a chat the bot has been added to. Used to validate the group id for
 * topic mode, and to tell the operator what is actually wrong.
 */
async function getChat(token, chatId) {
  const chat = await call(token, "getChat", { chat_id: chatId });
  return {
    id: chat.id,
    type: chat.type,
    title: chat.title || chat.username || String(chat.id),
    isForum: chat.is_forum === true,
  };
}

/**
 * Check the bot's own membership and rights in a chat.
 */
async function getBotMembership(token, chatId, botId) {
  const member = await call(token, "getChatMember", { chat_id: chatId, user_id: botId });
  return {
    status: member.status,
    canManageTopics: member.can_manage_topics === true,
    canPostMessages: member.can_post_messages !== false,
  };
}

/**
 * Full pre-flight for group topic mode. Returns a list of human-readable
 * problems rather than throwing on the first one, so the operator can fix
 * everything in one pass instead of playing whack-a-mole.
 */
async function checkGroup(token, chatId) {
  const problems = [];
  const me = await getMe(token);

  let chat;
  try {
    chat = await getChat(token, chatId);
  } catch (e) {
    return {
      bot: me,
      chat: null,
      problems: [
        "Could not read that chat: " +
          e.message +
          ". Check the id, and make sure the bot has been added to the group.",
      ],
    };
  }

  if (chat.type === "private") {
    problems.push("That id is a private chat, not a group. Topic mode needs a group.");
  }
  if (chat.type === "channel") {
    problems.push(
      "That is a channel. Bots can post to channels but cannot hold a conversation " +
        "in one; use a group instead."
    );
  }
  if ((chat.type === "group" || chat.type === "supergroup") && !chat.isForum) {
    problems.push(
      "Topics are not enabled on that group. Group Settings → Topics → turn on."
    );
  }

  try {
    const member = await getBotMembership(token, chat.id, me.id);
    if (member.status !== "administrator") {
      problems.push(
        "The bot is not an administrator of that group (it is '" +
          member.status +
          "'). It needs admin rights to manage topics."
      );
    } else if (chat.isForum && !member.canManageTopics) {
      problems.push("The bot is an admin but lacks the 'Manage Topics' permission.");
    }
  } catch (e) {
    problems.push("Could not read the bot's membership: " + e.message);
  }

  if (!me.canJoinGroups) {
    problems.push(
      "This bot is not allowed to join groups. In @BotFather: /mybots → the bot → " +
        "Bot Settings → Allow Groups? → Turn groups on."
    );
  }
  if (me.canReadAllGroupMessages === false) {
    // Not fatal: with privacy mode on the bot still sees replies and mentions.
    problems.push(
      "Privacy mode is on, so the bot only sees messages that mention it or reply " +
        "to it. To let it read everything: @BotFather → Bot Settings → Group Privacy → Turn off."
    );
  }

  return { bot: me, chat, problems };
}

module.exports = { looksLikeToken, getMe, getChat, getBotMembership, checkGroup };
