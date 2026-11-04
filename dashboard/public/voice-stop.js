"use strict";
/*
 * "Stop listening", said aloud: the spoken command that closes the mic.
 *
 * In hands-free the mic stays open and a pause sends what was said, so the
 * only way out used to be a click. Now saying "stop listening", "close the
 * live session", "وقف الاستماع", "اقفل ال live session" and the like closes it
 * too -- exactly as the mic button would -- and the words are not sent.
 *
 * Ending the call works the same way (2026-09-29, the administrator in live
 * mode: "Perfect, thank you so much. Now end the conversation, please."):
 * "end the conversation", "hang up", «اقفل المكالمة», «ممكن تقفلي المكالمة»,
 * «كفاية كده» -- with pleasantries in front ("perfect", "thank you so
 * much", «تمام», «شكرا») that do not count toward the word cap. Never with a
 * qualifier ("end the conversation with the supplier", «اقفل المكالمة مع
 * العميل») and never "that's all" / "we're done for now".
 *
 * Only when the whole utterance is the command. "Why did the service stop
 * listening on port 80" is a question, and is sent as one: the text is
 * normalised (case, punctuation, Arabic letter forms), a few polite words
 * around it are allowed ("okay", "please", "خلاص", "يا جويا"), and what is
 * left must be one of the phrases below, word for word.
 *
 * Undo works the same way (2026-09-29, the administrator said "Undo." to
 * close the Missions sheet the voice had opened, and it went to JOYA AI as a
 * plain turn): undo() is true for "undo", "undo that", "go back", "never
 * mind", "cancel that", «رجّعها», «رجع», «ألغي ده», «لأ خلاص», «ارجعي»...
 * as the whole utterance only -- never "undo the last git commit", "go back
 * to the Odoo question" or «رجع للموضوع اللي فات». The caller acts on it only
 * while a screen action can still be undone (its toast's Undo); otherwise the
 * words go on as an ordinary turn.
 *
 * Loaded on every page before console.js and joya-ai.js (window.VoiceStop),
 * and required by the server for the voice front desk, which hears the words
 * itself (module.exports). Pure: no DOM, no state.
 */
var VoiceStop = (function () {
  // Verbs x objects, English then Egyptian Arabic, all already normalised
  // (lowercase; alef, ya and ta marbuta in one form each -- see norm()).
  var EN_VERBS = ["stop", "close", "end", "quit", "exit", "pause", "turn off", "switch off", "shut off", "finish", "hang up", "wrap up"];
  var EN_OBJECTS = [
    "listening", "listen", "the listening",
    "live", "the live", "live session", "the live session", "live mode", "the live mode",
    "hands free", "the hands free", "hands free mode",
    "the mic", "mic", "the microphone", "microphone",
    // the call itself
    "conversation", "the conversation", "this conversation", "our conversation",
    "call", "the call", "this call",
    "live conversation", "the live conversation", "voice chat", "the voice chat",
  ];
  // (the feminine imperatives too: the voice can be addressed as a woman)
  var AR_VERBS = ["وقف", "اوقف", "قفل", "اقفل", "سكر", "بطل", "انهي", "اطفي", "اقفلي", "قفلي", "وقفي", "بطلي", "سكري", "اطفي"];
  var AR_OBJECTS = [
    "الاستماع", "استماع", "السماع",
    "اللايف", "ال لايف", "لايف", "اللايف سيشن", "ال لايف سيشن", "لايف سيشن",
    "ال live", "ال live session", "live", "live session", "الجلسه المباشره",
    "المايك", "الميك", "المايكروفون", "الميكروفون",
    // the call itself
    "المكالمه", "الكول", "ال كول", "المحادثه", "الكلام ده", "الكلام",
    // English written in Arabic script (gpt-transcribe, and whisper on this server, write it so)
    "كول", "الليسنينج", "ليسنينج", "ليسننج", "المايك ده",
  ];
  // English verbs written in Arabic script ("ستوب الليسنينج", "اند الكول"): with either object list.
  var AR_SCRIPT_EN_VERBS = ["ستوب", "كلوز", "اند", "بوز"];
  // Whole commands that are not verb + object.
  var EXTRA = [
    "stop listening now", "you can stop listening", "stop listening to me",
    "mic off", "microphone off", "listening off", "live off", "hands free off",
    "بطل تسمع", "كفايه استماع", "خلاص كده اقفل",
    "hang up", "hang up now", "you can hang up", "hang up the phone",
    "كفايه كده", "خلاص كده شكرا", "كده شكرا", "كفايه كده شكرا", "خلاص كفايه كده",
  ];
  // Allowed around the command, never on their own.
  var LEAD = ["ok", "okay", "alright", "all right", "please", "hey joya", "joya ai", "joya", "joya", "so", "now",
    "خلاص", "طيب", "يا جويا", "جويا", "من فضلك", "لو سمحت", "اوكي", "اوكيه", "بليز"];
  var TAIL = ["please", "for now", "now", "thanks", "thank you", "joya", "joya ai",
    "خلاص", "من فضلك", "لو سمحت", "دلوقتي", "شكرا", "يا جويا", "بليز", "ثانكس"];
  // A request: one of these, once, right before a whole command ("can you
  // stop listening", "عايزك تقفل اللايف"). Longest first. "ممكن ت" is the
  // prefix written apart ("ممكن تـ قفل" once normalised); written onto the
  // verb it is the second-person form below.
  var ASK = ["can you please", "could you please", "would you please", "will you please",
    "can you", "could you", "would you", "will you", "i want you to", "i need you to",
    "ممكن ت", "ممكن", "عايزك", "عاوزك", "محتاجك", "يا ريت", "ياريت"];
  // After a request, Arabic uses the verb's second-person form: تقفل, توقف...
  var AR_ASKED_VERBS = ["توقف", "تقفل", "تسكر", "تبطل", "تنهي", "تطفي", "توقفي", "تقفلي", "تسكري", "تبطلي", "تطفي"];
  // Pleasantries before a command ("perfect, thank you so much, now end the
  // conversation"): stripped first, and not counted toward the word cap.
  var PLEASANT = ["thank you so much", "thank you very much", "thanks so much", "thanks a lot", "thank you", "thanks",
    "perfect", "great", "awesome", "excellent", "wonderful", "cool", "nice", "good", "ok", "okay",
    "تمام", "حلو", "جميل", "ممتاز", "شكرا جدا", "شكرا", "متشكر", "متشكره", "الف شكر", "مرسي", "ثانكس", "بيرفكت"]
    .sort(function (a, b) { return b.length - a.length; });
  // Longer than this after normalising (pleasantries aside), it is a sentence, not a command.
  var MAX_WORDS = 9;

  // "Undo" said aloud: whole utterances only, normalised (see norm()).
  var UNDO = [
    "undo", "undo that", "undo it", "undo this", "undo the last one", "undo please",
    "go back", "go back please", "take that back", "take it back", "put it back", "put that back",
    "never mind", "nevermind", "cancel that", "cancel it", "cancel this", "revert that", "revert it",
    "change it back", "change that back", "no go back", "no undo that", "no never mind",
    // Egyptian Arabic, both genders ("رجّعها" once normalised is "رجعها")
    "رجعها", "رجعه", "رجعيها", "رجعيه", "رجع", "رجعي", "ارجع", "ارجعي", "رجعها تاني", "رجعيها تاني",
    "رجعها زي ما كانت", "رجعيها زي ما كانت", "رجعه زي ما كان", "رجعيه زي ما كان", "رجع زي ما كان", "رجعي زي ما كان",
    "الغي", "الغيها", "الغيه", "الغي ده", "الغي دا", "الغي دي", "الغيها دي", "الغي اللي عملته", "الغي اللي فات",
    "لا خلاص", "لا لا خلاص", "لا رجعها", "لا رجعيها", "لا الغيها", "لا الغي ده",
    "كانسل", "كانسل ده", "كانسلها", "انسي", "انسي ده", "انسي الموضوع ده",
    // English in Arabic script
    "اندو", "اندو ده", "اندو دي", "اندو بليز",
  ];
  var UNDO_SET = {};
  UNDO.forEach(function (p) { UNDO_SET[p] = true; });
  var UNDO_ASK = ["can you", "could you", "would you", "please", "ممكن ت", "ممكن", "عايزك ت", "عايزك", "عاوزك", "لو سمحت"];
  var UNDO_ASKED = {
    "undo that": 1, "undo it": 1, "go back": 1, "take that back": 1, "put it back": 1, "cancel that": 1, "revert that": 1, "change it back": 1,
    "ترجعها": 1, "ترجعيها": 1, "ترجعه": 1, "ترجعيه": 1, "تلغيها": 1, "تلغي ده": 1, "تلغيه": 1,
    "رجعها": 1, "رجعيها": 1, "الغيها": 1, "الغي ده": 1,
  };

  // A confirm for a Tier-2 screen action ("Switch the voice to cedar?"):
  // yes() and no(), whole utterances only, read on the server's transcript.
  var YES = ["yes", "yes please", "yes do it", "yes go ahead", "yeah", "yeah do it", "yep", "yup", "sure", "sure go ahead", "confirm", "confirmed",
    "i confirm", "do it", "go ahead", "please do", "yes confirm", "ok do it", "okay do it", "ok go ahead", "okay go ahead", "yes switch it", "switch it",
    "ايوه", "ايوا", "ايوه اعمل كده", "ايوه اعملي كده", "ايوه اعملها", "ايوه اعمليها", "اه", "اه اعملها", "اه اعمليها", "اعملها", "اعمليها",
    "اعمل كده", "اعملي كده", "ماشي", "ماشي اعملها", "موافق", "موافقه", "اكيد", "طبعا", "يلا", "يلا اعملها", "نعم", "اكد", "اكدي", "غيرها", "غيريها", "ايوه غيرها", "ايوه غيريها",
    // English in Arabic script
    "يس", "يس بليز", "اوكي اعملها", "شور", "كونفيرم", "جو اهيد"];
  var NO = ["no", "no thanks", "no thank you", "nope", "cancel", "cancel it", "cancel that", "don't", "dont", "don't do it", "dont do it", "never mind", "nevermind", "leave it",
    "لا", "لأ", "لا شكرا", "لا خلاص", "لا متعملش", "لا متعمليش", "متعملش", "متعمليش", "بلاش", "خليها", "خليه", "سيبها", "سيبيها", "مش عايز", "مش عايزه", "الغي", "الغيها", "كانسل",
    "نو", "نو ثانكس", "نوب"];
  var YES_SET = {}, NO_SET = {};
  YES.forEach(function (p) { YES_SET[norm(p)] = true; });
  NO.forEach(function (p) { NO_SET[norm(p)] = true; });

  var PHRASES = {};
  function add(p) { PHRASES[p] = true; }
  EN_VERBS.forEach(function (v) { EN_OBJECTS.forEach(function (o) { add(v + " " + o); }); });
  AR_VERBS.forEach(function (v) { AR_OBJECTS.forEach(function (o) { add(v + " " + o); }); });
  AR_SCRIPT_EN_VERBS.forEach(function (v) { AR_OBJECTS.concat(EN_OBJECTS).forEach(function (o) { add(v + " " + o); }); });
  EN_VERBS.forEach(function (v) { AR_OBJECTS.forEach(function (o) { add(v + " " + o); }); });
  EXTRA.forEach(add);
  // Only after a request (ASK): "ممكن تقفل الاستماع", "عايزك تبطل تسمع".
  var ASKED = {};
  AR_ASKED_VERBS.forEach(function (v) { AR_OBJECTS.forEach(function (o) { ASKED[v + " " + o] = true; }); });
  ASKED["تبطل تسمع"] = true;

  /**
   * Lowercase; Arabic diacritics and tatweel out; alef forms to ا, ى to ي,
   * ة to ه, ؤ to و, ئ to ي; Arabic and Latin letters that touch are split;
   * hyphens joining words become spaces; anything else that is not a Latin
   * or Arabic letter or digit goes; spaces squeezed.
   */
  function norm(text) {
    return String(text == null ? "" : text)
      .toLowerCase()
      .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
      .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
      .replace(/\u0649/g, "\u064A")
      .replace(/\u0629/g, "\u0647")
      .replace(/\u0624/g, "\u0648")
      .replace(/\u0626/g, "\u064A")
      // "al-" written onto an English word ("الـlive"): split them
      .replace(/([\u0621-\u064A])([a-z])/g, "$1 $2")
      .replace(/([a-z])([\u0621-\u064A])/g, "$1 $2")
      .replace(/[^a-z0-9\u0621-\u064A\u0660-\u0669]+/g, " ")
      .replace(/^ +| +$/g, "");
  }

  function strip(s, words, atEnd) {
    for (var again = true; again && s;) {
      again = false;
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        if (atEnd ? s.slice(-(w.length + 1)) === " " + w : s.slice(0, w.length + 1) === w + " ") {
          s = atEnd ? s.slice(0, -(w.length + 1)) : s.slice(w.length + 1);
          again = true;
        }
      }
    }
    return s;
  }

  /** True when what was said is the stop command and nothing more. */
  function heard(text) {
    var s = norm(text);
    if (!s) return false;
    if (PHRASES[s]) return true;
    s = strip(s, PLEASANT, false);
    if (!s || s.split(" ").length > MAX_WORDS) return false;
    if (PHRASES[s]) return true;
    var lead = strip(s, LEAD, false);
    if (PHRASES[lead]) return true;
    s = strip(lead, TAIL, true);
    if (PHRASES[s]) return true;
    // "Can you stop listening": one request, then the whole command.
    for (var i = 0; i < ASK.length; i++) {
      if (s.slice(0, ASK[i].length + 1) === ASK[i] + " ") {
        var rest = s.slice(ASK[i].length + 1);
        return !!(PHRASES[rest] || ASKED[rest]);
      }
    }
    return false;
  }

  function confirmWord(set, text) {
    var s = norm(text);
    if (!s) return false;
    if (set[s]) return true;
    s = strip(s, PLEASANT.filter(function (p) { return !set[p]; }), false);
    if (!s || s.split(" ").length > MAX_WORDS) return false;
    s = strip(strip(s, LEAD.filter(function (p) { return !set[p]; }), false), TAIL, true);
    return !!set[s];
  }
  /** "Yes" (or «أيوه»...) and nothing more: the confirm of a pending Tier-2 screen action. */
  function yes(text) { return confirmWord(YES_SET, text); }
  /** "No" (or «لأ»...) and nothing more: the pending confirm is cancelled. */
  function no(text) { return confirmWord(NO_SET, text); }

  /** True when what was said is "undo" (or the like) and nothing more. */
  function undo(text) {
    var s = norm(text);
    if (!s) return false;
    if (UNDO_SET[s]) return true;
    s = strip(s, PLEASANT.filter(function (p) { return p !== "ok" && p !== "okay"; }), false);
    if (!s || s.split(" ").length > MAX_WORDS) return false;
    s = strip(strip(s, LEAD, false), TAIL, true);
    if (UNDO_SET[s]) return true;
    for (var i = 0; i < UNDO_ASK.length; i++) {
      if (s.slice(0, UNDO_ASK[i].length + 1) === UNDO_ASK[i] + " ") {
        var rest = strip(s.slice(UNDO_ASK[i].length + 1), TAIL, true);
        return !!(UNDO_SET[rest] || UNDO_ASKED[rest]);
      }
    }
    return false;
  }

  return {
    heard: heard, norm: norm, undo: undo, yes: yes, no: no,
    undoPhrases: function () { return UNDO.slice(); },
    pleasantries: function () { return PLEASANT.slice(); },
    phrases: function () { return Object.keys(PHRASES); },
    asked: function () { return Object.keys(ASKED); },
    requests: function () { return ASK.slice(); },
  };
})();
if (typeof module === "object" && module.exports) module.exports = VoiceStop;
