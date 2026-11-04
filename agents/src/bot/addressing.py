"""Respond only when asked: decide whether a group message is addressed to the bot.

JOYA addition. With ``GROUP_RESPOND_MODE=mention`` the bot acts in a group chat
only on a message that

* @mentions the bot's username (in the text or a caption, or a text mention of
  the bot's user),
* is a reply to one of the bot's own messages,
* is a /command addressed to it (``/cmd@thisbot``, or a bare ``/cmd`` that this
  bot registered), or
* names the bot by one of ``BOT_NAME_ALIASES`` (whole word, any case, anywhere).

Everything else is dropped before any middleware runs: no reply, no reaction,
no rate-limit charge, no Claude call -- a debug log line only. Private chats
are never filtered, and the default mode (``all``) changes nothing.
"""

import re
from typing import Any, Iterable, List, Optional, Tuple

# Arabic one-letter proclitics that attach to the next word (wa-, fa-, bi-,
# li-, ka-) and the vocative particle "ya", which may be written apart or
# joined: "ومافيكس", "يا مافيكس", "يامافيكس".
_AR_PREFIX = r"(?:يا\s*|[وفبلك])?"
_ARABIC = re.compile(r"[؀-ۿ]")
# What may sit between a leading name and the request: punctuation, an
# Arabic comma, dashes, and blanks.
_SEP = r"[\s,:;!.?\-–—،]*"
_LEAD_GREETING = r"(?:(?:hey|hi|hello|ok|okay|yo|dear|يا)\s*,?\s*)?"


def _alias_pattern(alias: str) -> str:
    escaped = re.escape(alias)
    if _ARABIC.search(alias):
        return r"(?<!\w)" + _AR_PREFIX + escaped + r"(?!\w)"
    return r"(?<!\w)" + escaped + r"(?!\w)"


def _texts(message: Any) -> List[str]:
    out = []
    for attr in ("text", "caption"):
        value = getattr(message, attr, None)
        if isinstance(value, str) and value:
            out.append(value)
    return out


def _entities(message: Any) -> Iterable[Any]:
    for attr in ("entities", "caption_entities"):
        value = getattr(message, attr, None)
        if isinstance(value, (list, tuple)):
            yield from value


def is_group_chat(chat: Any) -> bool:
    return getattr(chat, "type", None) in ("group", "supergroup")


def _is_reply_to_bot(message: Any, bot_id: Optional[int]) -> bool:
    reply = getattr(message, "reply_to_message", None)
    if reply is None or bot_id is None:
        return False
    # In a forum topic every message "replies" to the topic's creation
    # message. When the bot made the topic, that is the bot's message -- but it
    # is not the user replying to the bot.
    if getattr(reply, "forum_topic_created", None) is not None:
        return False
    thread_id = getattr(message, "message_thread_id", None)
    if (
        getattr(message, "is_topic_message", None) is True
        and thread_id is not None
        and getattr(reply, "message_id", None) == thread_id
    ):
        return False
    sender = getattr(reply, "from_user", None)
    return getattr(sender, "id", None) == bot_id


def _command(text: str) -> Optional[Tuple[str, Optional[str]]]:
    m = re.match(r"^/([A-Za-z0-9_]{1,64})(?:@([A-Za-z0-9_]{3,64}))?(?:\s|$)", text)
    if not m:
        return None
    return m.group(1).lower(), m.group(2)


def addressed_reason(
    message: Any,
    *,
    bot_username: str,
    bot_id: Optional[int],
    aliases: Iterable[str],
    known_commands: Iterable[str],
) -> Optional[str]:
    """Why this message is addressed to the bot, or None when it is not."""
    username = (bot_username or "").lstrip("@")
    texts = _texts(message)

    for text in texts:
        cmd = _command(text.lstrip())
        if cmd:
            name, target = cmd
            if target:
                if target.lower() == username.lower():
                    return "command"
                # /cmd@otherbot is someone else's.
                return None
            if name in {c.lower() for c in known_commands}:
                return "command"

    if username:
        at = re.compile(r"(?<![\w@])@" + re.escape(username) + r"(?!\w)", re.I)
        if any(at.search(t) for t in texts):
            return "mention"
    for ent in _entities(message):
        user = getattr(ent, "user", None)
        if (
            getattr(ent, "type", None) == "text_mention"
            and bot_id is not None
            and getattr(user, "id", None) == bot_id
        ):
            return "mention"

    if _is_reply_to_bot(message, bot_id):
        return "reply"

    for alias in aliases:
        if not alias:
            continue
        pat = re.compile(_alias_pattern(alias), re.I)
        if any(pat.search(t) for t in texts):
            return "name"
    return None


def strip_address(text: str, bot_username: str, aliases: Iterable[str]) -> str:
    """Remove a leading @mention or name from a prompt ("Mavix, do X" -> "do X").

    Only a LEADING address is removed: a name in the middle of a sentence is
    part of what was said. If nothing would be left, the text is kept as it is.
    """
    if not text:
        return text
    original = text
    username = (bot_username or "").lstrip("@")
    heads = []
    if username:
        heads.append(r"@" + re.escape(username) + r"(?!\w)")
    for alias in sorted((a for a in aliases if a), key=len, reverse=True):
        heads.append(_alias_pattern(alias))
    if not heads:
        return text
    lead = re.compile(
        r"^\s*" + _LEAD_GREETING + r"(?:" + "|".join(heads) + r")" + _SEP, re.I
    )
    stripped = text
    # "@bot Mavix, ..." -- take off up to two leading addresses.
    for _ in range(2):
        m = lead.match(stripped)
        if not m or m.end() == 0:
            break
        stripped = stripped[m.end() :]
    stripped = stripped.strip()
    return stripped if stripped else original
