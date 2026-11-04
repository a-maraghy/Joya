"""Respond only when asked: which group messages are addressed to the bot."""

from datetime import UTC, datetime

from telegram import Chat, ForumTopicCreated, Message, MessageEntity, User

from src.bot.addressing import addressed_reason, strip_address

BOT = User(id=4242, is_bot=True, first_name="Mavix", username="mavix_eg_bot")
ALICE = User(id=1, is_bot=False, first_name="Alice")
GROUP = Chat(id=-1009999999999, type="supergroup", title="G", is_forum=True)
KNOWN = {"start", "new", "status", "verbose", "repo", "restart", "sync_threads"}
ALIASES = ["MAVIX", "مافيكس"]


def msg(
    text=None, caption=None, reply=None, entities=None, thread=None, topic=None, mid=50
):
    return Message(
        message_id=mid,
        date=datetime.now(UTC),
        chat=GROUP,
        from_user=ALICE,
        text=text,
        caption=caption,
        reply_to_message=reply,
        entities=entities,
        message_thread_id=thread,
        is_topic_message=topic,
    )


def why(message):
    return addressed_reason(
        message,
        bot_username="mavix_eg_bot",
        bot_id=4242,
        aliases=ALIASES,
        known_commands=KNOWN,
    )


def test_mention_by_username_any_case():
    assert why(msg("@Mavix_EG_bot what is up")) == "mention"
    assert why(msg("thanks @mavix_eg_bot!")) == "mention"


def test_mention_of_a_longer_username_does_not_count():
    assert why(msg("@mavix_eg_bot2 hi")) is None
    assert why(msg("mail me at x@mavix_eg_bot")) is None


def test_caption_mention_counts():
    assert why(msg(caption="@mavix_eg_bot read this")) == "mention"


def test_text_mention_entity_of_the_bot():
    ent = MessageEntity(type="text_mention", offset=0, length=5, user=BOT)
    assert why(msg("Mavi, look", entities=[ent])) in ("mention", "name")
    ent2 = MessageEntity(type="text_mention", offset=0, length=4, user=ALICE)
    assert why(msg("Bob, look", entities=[ent2])) is None


def test_reply_to_the_bot_counts():
    bot_msg = Message(
        message_id=10, date=datetime.now(UTC), chat=GROUP, from_user=BOT, text="done"
    )
    assert why(msg("and now the next one", reply=bot_msg)) == "reply"


def test_reply_to_someone_else_does_not_count():
    other = Message(
        message_id=10, date=datetime.now(UTC), chat=GROUP, from_user=ALICE, text="hi"
    )
    assert why(msg("agreed", reply=other)) is None


def test_topic_root_made_by_the_bot_is_not_a_reply():
    root = Message(
        message_id=76,
        date=datetime.now(UTC),
        chat=GROUP,
        from_user=BOT,
        forum_topic_created=ForumTopicCreated(name="MAVIX", icon_color=7322096),
    )
    assert why(msg("just chatting", reply=root, thread=76, topic=True)) is None


def test_commands():
    assert why(msg("/new@mavix_eg_bot")) == "command"
    assert why(msg("/new")) == "command"
    assert why(msg("/status please")) == "command"
    assert why(msg("/new@some_other_bot")) is None
    assert why(msg("/weather")) is None
    assert why(msg("/weather@mavix_eg_bot tomorrow")) == "command"


def test_name_aliases():
    assert why(msg("Mavix, summarise this")) == "name"
    assert why(msg("can mavix check the stock?")) == "name"
    assert why(msg("MAVIX")) == "name"
    assert why(msg("mavixes are not a thing")) is None
    assert why(msg("مافيكس شوف الملف ده")) == "name"
    assert why(msg("يا مافيكس ممكن تساعدني")) == "name"
    assert why(msg("ومافيكس كمان")) == "name"


def test_not_addressed():
    assert why(msg("lunch at 2?")) is None
    assert why(msg(caption="holiday photo")) is None
    assert why(msg()) is None


def test_no_aliases_configured():
    m = msg("Mavix, summarise this")
    assert (
        addressed_reason(
            m,
            bot_username="mavix_eg_bot",
            bot_id=4242,
            aliases=[],
            known_commands=KNOWN,
        )
        is None
    )


def test_strip_leading_address():
    s = lambda t: strip_address(t, "mavix_eg_bot", ALIASES)  # noqa: E731
    assert (
        s("@mavix_eg_bot what is the stock of basil?") == "what is the stock of basil?"
    )
    assert s("Mavix, what is the stock?") == "what is the stock?"
    assert s("hey mavix: list the files") == "list the files"
    assert s("@mavix_eg_bot Mavix — do it") == "do it"
    assert s("يا مافيكس، شوف الملف") == "شوف الملف"
    assert s("can mavix check the stock?") == "can mavix check the stock?"
    assert s("@mavix_eg_bot") == "@mavix_eg_bot"
    assert s("plain text") == "plain text"
