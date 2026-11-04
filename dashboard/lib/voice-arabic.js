"use strict";
/**
 * Arabic for the voice guards (Phase 0 of M-3, 2026-09-29): what the voice's
 * output guard (lib/voice-shared.js, was voice-desk.js) and the transcript guard (lib/voice-guard.js)
 * need to read Egyptian and Modern Standard Arabic as strictly as English.
 *
 * Why: the guards were written for English. Probed offline on 2026-09-29, all
 * five Arabic or mixed false claims were spoken -- «تم إعادة تشغيل أودو»,
 * «وافقت على الطلب», «أنا deleted the old backups خلاص», «الديسك وصل ٩٣ في
 * المية» (a figure not in the snapshot) -- because numbers were read in ASCII
 * digits only, and every claim, negation and hedge rule used ASCII \b / \w and
 * English words.
 *
 * What is here, all pure (no I/O):
 *
 *   normalize()     one spelling for comparison: Arabic-Indic (٠-٩) and
 *                   Eastern (۰-۹) digits to ASCII, ٫ ٬ ٪ to . , %, tatweel and
 *                   diacritics removed, أ إ آ ٱ → ا, ى → ي, ة → ه, ؤ → و, ئ → ي
 *   numberWords()   Arabic number words (0-999, thousands, "و نص"), Egyptian
 *                   and MSA, so «واحد وأربعين» is 41 and «تسعين» is 90
 *   uni()           an ASCII regex made Unicode-aware: \b and \w over \p{L}\p{N}
 *   the lexicon     claims of action (done / I did / it was done / I am doing
 *                   / I will), approvals and refusals, negations (incl. the
 *                   Egyptian ما…ش), hedges, states, status terms, the hand-off
 *                   to JOYA AI -- with clitics (و ف ب ل ال, pronoun suffixes)
 *   fail closed     scriptOf(): letters that are neither Latin nor Arabic;
 *                   unparsed(): an Arabic word shaped like a past-tense result
 *                   ("…ت", "ات…") that the lexicon does not know
 *
 * Every form below is written as normalize() leaves it (ة → ه, أ → ا, ى → ي).
 */

/* ------------------------------------------------------ normalisation -- */

const AR_LETTER = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

/** Arabic-Indic and Eastern digits, and the Arabic separators, as ASCII. */
function digits(text) {
  return String(text == null ? "" : text)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/(\d)٫(?=\d)/g, "$1.") // ٫ decimal separator
    .replace(/(\d)٬(?=\d)/g, "$1,") // ٬ thousands separator
    .replace(/٫/g, ".")
    .replace(/٪/g, "%"); // ٪
}

/** One spelling for comparison (not for display). Latin text passes unchanged. */
function normalize(text) {
  let t = digits(text);
  if (!AR_LETTER.test(t)) return t;
  return t
    .replace(/[ﭐ-﷿ﹰ-﻿]/g, (c) => c.normalize("NFKC")) // presentation forms
    .replace(/ـ/g, "") // tatweel
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۭ]/g, "") // diacritics, shadda, sukun
    .replace(/[أإآٱ]/g, "ا") // أ إ آ ٱ → ا
    .replace(/ى/g, "ي") // ى → ي
    .replace(/ة/g, "ه") // ة → ه
    .replace(/ؤ/g, "و") // ؤ → و
    .replace(/ئ/g, "ي") // ئ → ي
    .replace(/ی/g, "ي") // Persian yeh
    .replace(/ک/g, "ك") // Persian kaf
    .replace(/،/g, "،"); // (kept: the Arabic comma splits clauses)
}

function hasArabic(text) {
  return AR_LETTER.test(String(text || ""));
}

const WORD_RE = /[\p{L}\p{N}_]+/gu;
const AR_WORD = /^[؀-ۿ]+$/;

/** Words of a (normalized) text with their offsets. */
function wordsOf(text) {
  const out = [];
  for (const m of String(text || "").matchAll(WORD_RE)) out.push({ w: m[0], idx: m.index });
  return out;
}

/**
 * Which scripts the letters of a text are in. `other` counts letters that are
 * neither Latin nor Arabic (Cyrillic, Hebrew, CJK, Devanagari...).
 */
function scriptOf(text) {
  let arabic = 0;
  let latin = 0;
  let other = 0;
  let arWords = 0;
  let laWords = 0;
  for (const ch of String(text || "")) {
    if (!/\p{L}/u.test(ch)) continue;
    if (/\p{Script=Common}|\p{Script=Inherited}/u.test(ch)) continue; // tatweel, marks
    if (/\p{Script=Arabic}/u.test(ch)) arabic++;
    else if (/\p{Script=Latin}/u.test(ch)) latin++;
    else other++;
  }
  for (const m of String(text || "").matchAll(/\p{L}+/gu)) {
    if (/\p{Script=Arabic}/u.test(m[0])) arWords++;
    else if (/\p{Script=Latin}/u.test(m[0])) laWords++;
  }
  return { arabic, latin, other, arWords, laWords };
}

/** Is this (sentence, reply, utterance) Arabic enough to answer in Arabic? */
function isArabic(text) {
  const s = scriptOf(text);
  return s.arWords > 0 && s.arWords * 3 >= s.laWords;
}

/* -------------------------------------------------- Unicode boundaries -- */

const W = "[\\p{L}\\p{N}_]";
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;

/**
 * The same regex, Unicode-aware: \b and \w see Arabic (and every other) letter
 * as a letter. For ASCII text it matches exactly what the original matched.
 */
function uni(re) {
  const src = re.source;
  let out = "";
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const n = src[i + 1];
      if (n === "b" && !inClass) out += B;
      else if (n === "w") out += inClass ? "\\p{L}\\p{N}_" : W;
      else if (n === "W" && !inClass) out += "[^\\p{L}\\p{N}_]";
      else out += c + n;
      i++;
      continue;
    }
    if (c === "[" && !inClass) inClass = true;
    else if (c === "]" && inClass) inClass = false;
    out += c;
  }
  return new RegExp(out, re.flags.includes("u") ? re.flags : re.flags + "u");
}

/* ------------------------------------------------------------ numbers -- */

const n = (list, v) => Object.fromEntries(list.split(" ").map((w) => [normalize(w), v]));
const AR_NUM = {
  ...n("صفر", 0),
  ...n("واحد واحده", 1),
  ...n("اتنين اثنين اثنان اتنان اثنا اثني", 2),
  ...n("تلاته ثلاثه تلات ثلاث", 3),
  ...n("اربعه اربع", 4),
  ...n("خمسه خمس", 5),
  ...n("سته ست", 6),
  ...n("سبعه سبع", 7),
  ...n("تمانيه تمنيه ثمانيه تمان ثمان ثماني", 8),
  ...n("تسعه تسع", 9),
  ...n("عشره عشر", 10),
  ...n("حداشر احداشر احدعشر", 11),
  ...n("اتناشر اثناعشر", 12),
  ...n("تلتاشر تلطاشر", 13),
  ...n("اربعتاشر اربعطاشر", 14),
  ...n("خمستاشر خمسطاشر", 15),
  ...n("ستاشر سطاشر", 16),
  ...n("سبعتاشر سبعطاشر", 17),
  ...n("تمنتاشر تمنطاشر", 18),
  ...n("تسعتاشر تسعطاشر", 19),
  ...n("عشرين عشرون", 20),
  ...n("تلاتين ثلاثين ثلاثون", 30),
  ...n("اربعين اربعون", 40),
  ...n("خمسين خمسون", 50),
  ...n("ستين ستون", 60),
  ...n("سبعين سبعون", 70),
  ...n("تمانين ثمانين ثمانون", 80),
  ...n("تسعين تسعون", 90),
  ...n("ميه مايه مئه مائه مية", 100),
  ...n("ميتين مئتين مئتان متين", 200),
  ...n("تلتميه ثلاثمايه ثلاثمئه ثلاثميه", 300),
  ...n("ربعميه اربعمايه اربعمئه اربعميه", 400),
  ...n("خمسميه خمسمايه خمسمئه", 500),
  ...n("ستميه ستمايه ستمئه", 600),
  ...n("سبعميه سبعمايه سبعمئه", 700),
  ...n("تمنميه ثمانمايه ثمانمئه", 800),
  ...n("تسعميه تسعمايه تسعمئه", 900),
  ...n("الفين الفان", 2000),
};
const AR_MULT = { ...n("الف الاف", 1000), ...n("مليون ملايين", 1e6), ...n("مليار", 1e9) };
const AR_FRAC = { ...n("نص نصف", 0.5), ...n("ربع", 0.25) };
const ONE = new Set(["واحد", "واحده"]);

/** Digits said with Arabic words around them: "93 ونص" → 93.5, "20 الف" → 20000. */
function joinDigits(text) {
  return String(text)
    .replace(/(\d+(?:\.\d+)?)\s*و\s*(نص|نصف)(?![\p{L}])/gu, (_, d) => String(Number(d) + 0.5))
    .replace(/(\d+(?:\.\d+)?)\s*و\s*ربع(?![\p{L}])/gu, (_, d) => String(Number(d) + 0.25))
    .replace(/(\d+(?:\.\d+)?)\s*(?:الف|الاف)(?![\p{L}])/gu, (_, d) => String(Number(d) * 1000));
}

/**
 * Numbers said in Arabic words in a normalized text. Like the English reader,
 * a lone "one" (واحد) and a lone "half" (نص) are not figures; "في المية" is a
 * unit and adds nothing.
 */
function numberWords(text) {
  const out = [];
  let cur = null; // the group being read
  let total = 0;
  let words = 0;
  let lone = false;
  const flush = () => {
    if (cur !== null || total) {
      const v = total + (cur || 0);
      if (!(words === 1 && lone)) out.push(v);
    }
    cur = null;
    total = 0;
    words = 0;
    lone = false;
  };
  for (const { w: raw } of wordsOf(normalize(text))) {
    let w = raw;
    let conj = false;
    const known = (x) => AR_NUM[x] !== undefined || AR_MULT[x] !== undefined || AR_FRAC[x] !== undefined;
    if (!known(w) && w.startsWith("و") && known(w.slice(1))) {
      conj = true;
      w = w.slice(1);
    }
    if (AR_NUM[w] !== undefined) {
      const v = AR_NUM[w];
      if (cur !== null && !conj && (w === "عشر" || w === "عشره") && cur < 10) {
        cur += 10; // MSA teens: ثلاثه عشر
        words++;
        continue;
      }
      if (conj && (cur !== null || total)) {
        cur = (cur || 0) + v;
        words++;
        continue;
      }
      flush();
      cur = v;
      words = 1;
      lone = ONE.has(w);
      continue;
    }
    if (AR_MULT[w] !== undefined) {
      const m = AR_MULT[w];
      if (cur !== null && !conj) {
        total += cur * m;
        cur = null;
      } else {
        flush();
        total = m;
      }
      words++;
      continue;
    }
    if (AR_FRAC[w] !== undefined) {
      if (conj && (cur !== null || total)) {
        cur = (cur || 0) + AR_FRAC[w];
        words++;
        continue;
      }
      flush();
      continue;
    }
    flush();
  }
  flush();
  return out;
}

/* ------------------------------------------------------------ lexicon -- */

const set = (s) => new Set(s.split(/\s+/).filter(Boolean).map(normalize));

// Negation. A particle negates the word right after it (and the two after
// that); the Egyptian circumfix ما…ش / م…ش negates the verb it wraps.
const NEG = set("مش مو ما لا لم لن ليس ليست ليسوا مفيش مافيش محدش ماحدش بدون ولا مقدرتش ماقدرتش مقدرش مابقاش مبقاش مكنتش ماكنتش مكنش مكانش ماكانش مبقتش");
const NEG_PAIRS = [["من", "غير"], ["لسه", "ما"]];
const EN_NEG = new Set(["not", "never", "no", "nothing", "none", "cannot", "unable", "without", "didn't", "don't", "doesn't", "isn't", "aren't", "wasn't", "weren't", "haven't", "hasn't", "won't", "can't", "cant", "wont", "nobody", "neither", "nor"]);
const NEG_WINDOW = 3;
// "There is no / nobody / it is not": these deny the whole clause, as an
// English negation does ("مفيش أي دليل إن الباك اب اتمسح").
const NEG_CLAUSE = set("مفيش مافيش محدش ماحدش ليس ليست بدون");

// Hedges: a status claim that is only a maybe, a question or an intention to check.
const HEDGE = set("ممكن يمكن غالبا ربما احتمال احتمالا يحتمل لو اذا هل اشوف هشوف حشوف اتاكد هتاكد حتاكد نشوف هنشوف اسال هسال حسال");
// (Both genders: the voice's own gender follows how it is addressed -- «مش متأكد/ة», «مش عارف/ة».)
const HEDGE_PHRASES = ["علي الارجح", "في الغالب", "مش متاكد", "مش متاكده", "مش عارف", "مش عارفه", "مش واثق", "مش واثقه", "عايز يعرف", "عايزني", "عاوزني", "عايزه اتاكد", "حابه اتاكد"].map(normalize);

// Discourse words that may open a sentence before an action noun ("تمام، إعادة تشغيل أودو").
const OPENERS = set("تمام حاضر اوكي اوك ماشي طيب اه ايوه اكيد اوكيه طبعا اه");

// A short confirmation after an action sentence: that pair is the claim.
const CONFIRM = set("تمام خلاص تم تمت ايوه اه اوكي اوك حاضر ماشي اتعمل اشتغل رجع نجح نجحت خلصت خلص");

// "Right now / immediately": with an action, a promise.
const NOW = set("حالا فورا");
const NOW_PHRASES = ["دلوقتي حالا", "علي طول", "في الحال"].map(normalize);

/**
 * The action verbs, by concept. `en` is an English verb whose stem names the
 * concept, so an Arabic summary is compared with an English reply (and back).
 *   did1  I / we did it           (past, first person)        → action claim
 *   amb   the same form is also "it/she did it" (بعت، وقفت): first person at
 *         the desk, third person in a summary
 *   pass  it was done / got done   (Egyptian ات…, ان…)          → claim
 *   did3  he / it did it           (summary only: also a noun)
 *   prog1 I am doing it            (Egyptian ب…)               → claim
 *   prog3 it is being done         (بي…, جاري, يتم)            → claim
 *   fut1  I will do it             (ه… ح… سأ…)                 → promise
 *   fut3  it / JOYA AI will do it  (هي… سي… هيتم)              → promise
 *   noun  the action's name        (تشغيل، مسح)                → claim at the
 *         start of a sentence, like "Restarting Odoo."
 */
const VERBS = [
  {
    en: "do",
    generic: true,
    did1: "عملت سويت فعلت قمت عملنا سوينا قمنا نفذت نفذنا",
    pass: "اتعمل اتعملت اتنفذ اتنفذت انعمل",
    fut1: "هعمل حعمل هنفذ حنفذ ساعمل سانفذ ساقوم هقوم حقوم هنعمل حنعمل سنقوم",
    fut3: "هيعمل حيعمل هيتعمل حيتعمل سيتم هيتم حيتم سيقوم هيقوم حيقوم هيتنفذ سينفذ سيجري",
    prog1: "بعمل بنفذ بقوم بنعمل",
    prog3: "بيعمل بيتعمل بيتم يتم جاري جار بيتنفذ يجري",
    did3: "نفذ عمل قام",
  },
  {
    en: "done",
    generic: true,
    done: "تم تمت خلاص خلصت خلص خلصنا انتهي انتهت انتهيت انتهينا اكتمل اكتملت نجح نجحت اتحل اتحلت اتظبط اتظبطت اتمت اتممت خلصان خلصانه خلصانين",
  },
  {
    en: "finish",
    fut1: "هخلص حخلص هنخلص حنخلص",
    fut3: "هيخلص حيخلص هيتخلص",
    prog1: "بخلص بنخلص",
    prog3: "بيخلص بيتخلص",
  },
  {
    en: "delete",
    did1: "مسحت حذفت شلت مسحنا حذفنا شلنا",
    pass: "اتمسح اتمسحت اتحذف اتحذفت انمسح انمسحت انحذف انحذفت اتشال اتشالت",
    fut1: "همسح حمسح هحذف حاحذف ساحذف سامسح هنمسح هشيل حشيل",
    fut3: "هيمسح حيمسح هيحذف سيحذف هيتمسح هيتحذف سيتم",
    prog1: "بمسح بحذف بنمسح بشيل",
    prog3: "بيمسح بيحذف بيتمسح بيتحذف",
    did3: "مسح حذف شال",
    noun: "مسح حذف ازاله",
  },
  {
    en: "restart",
    did1: "اعدت",
    fut1: "هعيد حعيد ساعيد",
    fut3: "هيعيد حيعيد سيعيد",
    prog3: "بيعيد",
    did3: "اعاد",
    noun: "اعاده ريستارت ريسترت ريبوت",
  },
  {
    en: "start",
    did1: "شغلت شغلنا",
    pass: "اتشغل اتشغلت",
    fut1: "هشغل حشغل ساشغل هنشغل",
    fut3: "هيشغل حيشغل هيتشغل سيشغل",
    prog1: "بشغل",
    prog3: "بيشغل بيتشغل",
    did3: "شغل",
    noun: "تشغيل",
  },
  {
    en: "stop",
    did1: "اوقفت قفلت اقفلت وقفنا قفلنا",
    amb: "وقفت",
    pass: "اتوقف اتوقفت اتقفل اتقفلت",
    fut1: "هوقف حوقف هقفل حقفل ساوقف",
    fut3: "هيوقف حيوقف هيقفل هيتوقف سيوقف",
    prog1: "بوقف بقفل",
    prog3: "بيوقف بيقفل بيتوقف",
    did3: "اوقف قفل",
    noun: "ايقاف",
  },
  {
    en: "push",
    did1: "رفعت دفعت رفعنا دفعنا",
    pass: "اترفع اترفعت اتدفع",
    fut1: "هرفع حرفع سارفع هدفع",
    fut3: "هيرفع حيرفع سيرفع",
    prog1: "برفع بدفع",
    prog3: "بيرفع بيدفع",
    did3: "رفع دفع",
    noun: "بوش",
  },
  {
    en: "install",
    did1: "نصبت ثبتت سطبت نصبنا ثبتنا",
    pass: "اتنصب اتثبت اتسطب",
    fut1: "هنصب حنصب هثبت حثبت هسطب ساثبت",
    fut3: "هيتنصب هيتثبت هينصب",
    prog1: "بنصب بثبت بسطب",
    prog3: "بيتنصب بيتثبت",
    did3: "نصب ثبت",
    noun: "تنصيب تثبيت تسطيب",
  },
  {
    en: "update",
    did1: "حدثت حدثنا",
    pass: "اتحدث اتحدثت",
    fut1: "هحدث حاحدث ساحدث",
    fut3: "هيحدث هيتحدث",
    prog1: "بحدث",
    prog3: "بيحدث بيتحدث",
    noun: "تحديث ابديت",
  },
  {
    en: "send",
    did1: "بعتت ارسلت بعتنا ارسلنا",
    amb: "بعت",
    pass: "اتبعت اتبعتت اترسل اترسلت",
    fut1: "هبعت حبعت سارسل",
    fut3: "هيبعت حيبعت هيتبعت سيرسل",
    prog1: "ببعت",
    prog3: "بيبعت",
    did3: "ارسل",
    noun: "ارسال",
  },
  {
    en: "approve",
    did1: "وافقت اعتمدت وافقنا اعتمدنا",
    pass: "اتوافق اتعتمد اتقبل",
    fut1: "هوافق حوافق ساوافق هعتمد",
    fut3: "هيوافق حيوافق هيعتمد",
    prog1: "بوافق",
    prog3: "بيوافق",
    did3: "وافق اعتمد",
  },
  {
    en: "reject",
    did1: "رفضت رفضنا",
    pass: "اترفض اترفضت",
    fut1: "هرفض حرفض سارفض",
    fut3: "هيرفض حيرفض",
    prog1: "برفض",
    prog3: "بيرفض",
    did3: "رفض",
  },
  {
    en: "fix",
    did1: "صلحت اصلحت ظبطت عالجت صلحنا",
    pass: "اتصلح اتصلحت اتعالج",
    fut1: "هصلح حصلح هظبط حظبط ساصلح",
    fut3: "هيصلح حيصلح هيتصلح",
    prog1: "بصلح بظبط",
    prog3: "بيصلح بيتصلح",
    did3: "صلح اصلح ظبط عالج",
    noun: "اصلاح تصليح",
  },
  {
    en: "deploy",
    did1: "نشرت نشرنا",
    pass: "اتنشر",
    fut1: "هنشر حنشر",
    fut3: "هينشر",
    did3: "نشر",
    noun: "ديبلوي",
  },
  {
    en: "cancel",
    did1: "الغيت لغيت",
    pass: "اتلغي اتلغت",
    fut1: "هلغي حلغي",
    fut3: "هيلغي",
    did3: "الغي لغي",
    noun: "الغاء",
  },
  {
    en: "change",
    did1: "غيرت عدلت",
    pass: "اتغير اتغيرت اتعدل",
    fut1: "هغير حغير هعدل",
    fut3: "هيغير هيعدل",
    prog1: "بغير بعدل",
    did3: "عدل",
    noun: "تغيير تعديل",
  },
  {
    en: "move",
    did1: "نقلت",
    pass: "اتنقل",
    fut1: "هنقل حنقل",
    fut3: "هينقل",
    did3: "نقل",
  },
  {
    en: "clean",
    did1: "نضفت نظفت",
    pass: "اتنضف",
    fut1: "هنضف حنضف",
    noun: "تنظيف تنضيف",
  },
  {
    en: "create",
    did1: "انشات",
    pass: "اتنشا",
    did3: "انشا",
    noun: "انشاء",
  },
];

/**
 * Egyptian active participles that say an action is done and its result holds
 * ("أنا عاملة ده", "أنا مشغّلاه", "مسحاه" -- "I've done it", "I've got it
 * running", "I've wiped it"). The voice's own gender follows how the
 * administrator addresses it (lib/voice-persona.js), so both are here:
 * masculine, feminine (ة → ه) and plural bare; with an object suffix after the
 * feminine -ا / -ت (عاملاه، عاملته، مشغلاها) or straight on the masculine
 * (مشغلها، عاملهولك).
 *
 * A bare participle is a claim only after a first-person subject (أنا / احنا):
 * alone it is also a noun or an adjective (عامل "worker", منزل "house",
 * موافقة "approval"). With an object suffix it is a claim on its own. Each
 * base is the masculine form as normalize() spells it; some also have the
 * colloquial spelling without the long alef (مسحاه for ماسحاه).
 */
const PARTICIPLES = [
  ["do", "عامل منفذ عمل"],
  ["finish", "مخلص"],
  ["delete", "ماسح مسح حاذف حذف شايل شيل"],
  ["start", "مشغل"],
  ["stop", "موقف قافل قفل مقفل"],
  ["push", "رافع رفع"],
  ["install", "منزل منصب مثبت مسطب"],
  ["update", "محدث"],
  ["send", "باعت بعت مرسل"],
  ["approve", "موافق معتمد"],
  ["reject", "رافض رفض"],
  ["fix", "مصلح مظبط"],
  ["deploy", "ناشر"],
  ["cancel", "لاغي ملغي"],
  ["change", "مغير معدل"],
  ["move", "ناقل نقل"],
  ["clean", "منضف منظف"],
  ["restart", "معيد"],
];
const PTC = new Map(); // base -> en
for (const [en, forms] of PARTICIPLES) for (const f of forms.split(" ")) PTC.set(normalize(f), en);
const PTC_SUFFIX = ["هولك", "هولكم", "هوله", "هولها", "هالك", "ها", "هم", "ه"];
const FIRST_PERSON = set("انا احنا نحن");
// "How are you?" (عامل إيه / عاملة إيه) is small talk, not a claim.
const PTC_NOT_AFTER = set("ايه ازاي اي");

/**
 * Is `word` a participle of the table? {en, bare} -- bare when it has no
 * object suffix (then only a claim after أنا / احنا).
 */
function participle(word) {
  const w = CONJ.test(word) && word.length > 4 && !PTC.has(word) ? word.slice(1) : word;
  // With an object suffix after the feminine -ا / -ت: عاملاه، مشغلته، مسحاها.
  for (const s of PTC_SUFFIX) {
    if (!w.endsWith(s)) continue;
    const stem = w.slice(0, -s.length);
    for (const link of ["ا", "ت"]) {
      if (!stem.endsWith(link)) continue;
      const base = stem.slice(0, -1);
      // (-ت + suffix only on the full participle: مسحته is the verb مسحت + ه.)
      if (PTC.has(base) && (link === "ا" || base.length >= 4)) return { en: PTC.get(base), bare: false };
    }
  }
  // Masculine with an object suffix straight on it: مشغلها، عاملهولك.
  for (const s of PTC_SUFFIX) {
    if (s === "ه" || !w.endsWith(s)) continue;
    const base = w.slice(0, -s.length);
    if (PTC.has(base) && base.length >= 4) return { en: PTC.get(base), bare: false };
  }
  // Bare: masculine, feminine, plural.
  for (const end of ["", "ه", "ين"]) {
    if (end && !w.endsWith(end)) continue;
    const base = end ? w.slice(0, -end.length) : w;
    // (Only the full, long participles bare: مسح or بعت alone are the verb or the noun.)
    if (PTC.has(base) && base.length >= 4) return { en: PTC.get(base), bare: true };
  }
  return null;
}

/** Is there a first-person subject (أنا / احنا, or و+) in the two words before `i`? */
function firstPersonBefore(words, i) {
  for (let k = Math.max(0, i - 2); k < i; k++) {
    const w = words[k].w;
    if (FIRST_PERSON.has(w) || (CONJ.test(w) && FIRST_PERSON.has(w.slice(1)))) return true;
  }
  return false;
}

const ROLES = ["did1", "amb", "pass", "done", "did3", "prog1", "prog3", "fut1", "fut3", "noun"];
const LEX = new Map(); // form -> [{role, en, generic}]
for (const v of VERBS) {
  for (const role of ROLES) {
    if (!v[role]) continue;
    for (const f of set(v[role])) {
      if (!LEX.has(f)) LEX.set(f, []);
      LEX.get(f).push({ role, en: v.en, generic: !!v.generic });
    }
  }
}
const NOUN_ROLES = new Set(["noun"]);

// States of a service ("running" / "stopped"), with their sign; strong ones
// make a status claim even when the subject is only "it" / "everything".
const STATES = new Map([
  ...[..."شغال شغاله شغالين يعمل تعمل تعملان نشط نشطه اونلاين صاحي صاحيه مستقر مستقره سليم سليمه متاح متاحه".split(" ")].map((w) => [normalize(w), 1]),
  ...[..."واقف واقفه واقفين متوقف متوقفه وقف نازل نازله واقع واقعه عطلان عطلانه بايظ بايظه متعطل متعطله فاشل فاشله فشل فشلت فشلوا اوفلاين ميت ميته مضروب".split(" ")].map((w) => [normalize(w), -1]),
]);
const STATE_OTHER = set("تمام كويس كويسه الفل مليان مليانه فاضي فاضيه مشغول مشغوله معلق معلقه منتهي منتهيه مفتوح مفتوحه نضيف متزامن");
const STRONG = new Set([...STATES.keys(), ...set("مليان مليانه مشغول مشغوله معلق معلقه منتهي منتهيه")]);

// What a status is about, in the English terms the snapshot is keyed by.
const TERMS = new Map(
  Object.entries({
    odoo: "اودو",
    disk: "الديسك ديسك القرص الهارد التخزين المساحه الاسطوانه",
    memory: "الذاكره الرام رام الميموري",
    cpu: "المعالج البروسيسور",
    load: "اللود الحمل",
    service: "الخدمه الخدمات السيرفيس السيرفيسز خدمه خدمات",
    server: "السيرفر الخادم سيرفر",
    machine: "الماشين الجهاز",
    database: "الداتابيز الداتابيس",
    backup: "الباك باكاب الباكاب النسخ النسخه",
    log: "اللوج اللوجز السجلات",
    certificate: "الشهاده",
    site: "الموقع",
    email: "الايميل البريد",
    session: "الجلسه الجلسات السيشن السيشنز",
    mission: "المهمه المهام المشن المشنز",
    step: "الخطوه الخطوات",
    decision: "القرار القرارات",
    approval: "الموافقه الموافقات",
    dashboard: "الداشبورد",
    nginx: "انجينكس",
    postgres: "بوستجرس",
    firewall: "الفايروول الفايرول",
    agent: "الايجنت الايجنتس الوكيل الوكلاء",
    telegram: "تليجرام",
    github: "جيتهب",
    repo: "الريبو",
    commit: "الكوميت",
    branch: "البرانش",
    system: "السيستم النظام",
    vps: "السيرفر",
  }).flatMap(([en, ar]) => [...set(ar)].map((w) => [w, en]))
);
const PRONOUN = set("هو هي ده دي دول كله كلهم الاتنين هما");
const PRONOUN_PHRASES = ["كل حاجه", "كل الخدمات"].map(normalize);

// Words shaped like a past-tense result that are not one: the fail-closed
// check (unparsed) lets these through.
const T_SAFE = set(
  "انت وقت بيت كانت ليست مازالت لسه بقت ست تحت فات زيت صوت بنت شات سيت " +
    "سالت طلبت نسيت قصدت اخترت وصلت زادت نقصت قلت فضلت ظهرت لقيت شفت قريت سمعت فهمت عرفت اتاكدت لاحظت بصيت راجعت بتاعت ثابت موقت لست بقيت اتكلمت " +
    "سكريبت ريكويست بورت روت بوت جيت شيت كوميت تارجت فورمات انترنت بوست هوست ريستارت كنت"
);
const VERB_SUFFIX = new Set(["ه", "ها", "هم", "هن", "ني", "هاش", "لك", "له", "لها", "لهم", "لكم", "ليك", "لي", "لنا", "هولك", "هولكم", "هوله", "هولها", "هولهم", "هولي", "هولنا", "هالك"]);
const CONSTRUCT = set("رسالت حالت خدمت مشكلت مساحت نسخت مهمت خطوت قايمت سرعت صفحت جلست نتيجت طريقت");
const AT_SAFE = set("اتنين اتصال اتجاه اتفاق اتاحه اتساع اتكلم اتاكد اتفرج اتمني اتوقع اتفضل اتعلم اتصل");

// JOYA AI in either script.
const JOYA = "(?:joya|جويا|جوية)(?:\\s*(?:ai|اي\\s*اي|ايه\\s*اي|اي\\s*ايه))?";
// The hand-off verbs: ask, send, pass, tell, raise ("هسأل JOYA AI", "هبعت لـ JOYA AI").
const HANDOFF_STEMS = "سال|بعت|حول|وصل|بلغ|قول|قل|رسل|سلم|عدي|مرر|نقل|طلب";
const HANDOFF_AR = new RegExp(
  `(?<![\\p{L}\\p{N}_])[وف]?(?:(?:خليني|دعني|هقوم|حقوم)\\s+(?:ب)?)?(?:[هحب]|سا|س)?ا?(?:${HANDOFF_STEMS})\\p{L}*(?:\\s+[^\\s.,;!?،؛؟]+){0,4}?\\s*(?:ل|لل|الي|علي|مع|من)?\\s*${JOYA}(?![\\p{L}])`,
  "gu"
);
const HANDOFF_AR_FUTURE = new RegExp(`(?<![\\p{L}])(?:[وف]?(?:ه|ح|سا?)ا?(?:${HANDOFF_STEMS})|خليني|دعني|سوف|هقوم|حقوم)`, "u");
const OFFER_AR = /(?<![\p{L}])(?:تحب|تحبي|عايزني|عاوزني|تريدني|هل)(?![\p{L}])|؟\s*$/u;
// "I'll read you its answer when it arrives."
const ANSWER_PROMISE_AR = /(?<![\p{L}])[وف]?(?:[هح]|سا)(?:قرا|قول|بلغ|عرف|شارك|ابلغ|اخبر|نقل|بعت|ارسل)\p{L}*\s+(?:\S+\s+){0,3}?(?:ب|بال)?(?:رد|رده|الرد|اجابته|الاجابه|ردها|اجابه)(?![\p{L}])|(?<![\p{L}])(?:ب|بال)?(?:رده|الرد|اجابته|الاجابه|اجابه)\s+(?:\S+\s+){0,2}?(?:لما|اول\s+ما|بمجرد|عند|حين)\s*(?:ما\s+)?(?:يوصل|يرد|توصل|وصوله|وصولها|وصول)(?![\p{L}])/u;
// "JOYA AI said / replied ..."
const ATTR_VERBS = set("قال قالت بيقول يقول رد ردت جاوب بلغ اكد لقي شايف كتب اقترح بيقترح نصح وضح ذكر رد بيرد افاد");
const ANSWER_IS_AR = /(?<![\p{L}])(?:رده|ردها|الرد|اجابته|الاجابه)\s+(?:كان\s+|هو\s+|هي\s+)?(?:ان|انه|بيقول|يقول|كان)(?![\p{L}])/u;

// Recommendations, approvals and questions in a reply or a summary.
const RECOMMEND_AR = /(?<![\p{L}])(?:لازم|المفروض|ينصح|بينصح|نصح|انصح|بنصح|يقترح|بيقترح|اقترح|بقترح|نقترح|اقتراح|الافضل|احسن|يستحسن|يفضل|بيفضل|محتاج\s+تعمل|تحتاج\s+ان)(?![\p{L}])/u;
const REPLY_RECOMMEND_AR = /(?<![\p{L}])(?:لازم|المفروض|انصح|ينصح|اقترح|بقترح|الافضل|احسن|ممكن\s+تعمل|لو\s+عايز|لو\s+حابب|قولي|رد\s+علي|محتاج)(?![\p{L}])/u;
const NEEDS_APPROVAL_AR = /(?<![\p{L}])(?:محتاج|يحتاج|تحتاج|محتاجه|منتظر|مستني|في\s+انتظار|بانتظار|يتطلب|عايز|عاوز)(?![\p{L}])[^.\n]{0,40}?(?:موافق|قرار|رد|تاكيد|اختيار|اذن)\p{L}*|(?<![\p{L}])(?:توافق|توافقي|تحب|عايزني|عاوزني|اعمل\s+ايه)(?![\p{L}])[^.\n]{0,60}?؟|(?<![\p{L}])لو\s+وافقت/u;
const MENTIONS_APPROVAL_AR = /(?:موافق|توافق|قرار|تقرر|ردك|رأيك|رايك|تختار|اختيار|تاكيد|تاكد|اذنك|عايز\s+يعرف|بيسال|يسال|بيسالك|يسالك|تحب|تحبي|عايزني|عاوزني|قولي|قوليلي|بلغني|عرفني)/u;

/* ------------------------------------------------------------ reading -- */

const CONJ = /^[وف]/;
const PRON_SUFFIX = ["هاش", "هولكم", "هولك", "هولها", "هولهم", "هوله", "هولي", "هولنا", "هالك", "لكم", "ليك", "لها", "لهم", "لنا", "لك", "له", "لي", "ها", "هم", "هن", "كم", "ني", "ه", "ك"];
// "to you" straight on the verb (هبعتلك، هحدثك) -- not "it for you" (هعملهولك).
const ADDRESSEE = new Set(["لكم", "ليك", "لك", "كم", "ك"]);
const NOUN_PREFIX = ["وبال", "فبال", "وال", "فال", "بال", "كال", "ولل", "لل", "ال", "ب", "ل", "ك"];
const NOUN_SUFFIX = ["هم", "ها", "كم", "ك", "ه", "ي", "نا"];

/**
 * What a word could be, as the lexicon spells it: the word itself, without a
 * leading و/ف, without a pronoun suffix, and -- for the Egyptian negation --
 * without ما…ش / م…ش (then `negated`).
 */
function verbForms(word) {
  const out = [];
  const bases = [{ w: word, neg: false }];
  // (وتم: a two-letter form after و is read too, when the lexicon knows it.)
  if (CONJ.test(word) && (word.length > 3 || LEX.has(word.slice(1)))) bases.push({ w: word.slice(1), neg: false });
  // The future ه / ح written with a long alef: هاعمل, حامسح.
  for (const b of [...bases]) if (/^[هح]ا/.test(b.w) && b.w.length > 4) bases.push({ w: b.w[0] + b.w.slice(2), neg: false });
  for (const b of [...bases]) {
    if (b.w.length > 3 && b.w.endsWith("ش")) {
      const core = b.w.slice(0, -1);
      bases.push({ w: core, neg: true });
      if (core.startsWith("ما") && core.length > 3) bases.push({ w: core.slice(2), neg: true });
      else if (core.startsWith("م") && core.length > 2) bases.push({ w: core.slice(1), neg: true });
    }
  }
  for (const b of bases) {
    out.push({ ...b, suffix: "" });
    for (const s of PRON_SUFFIX) {
      if (b.w.endsWith(s) && b.w.length - s.length >= 2) {
        out.push({ w: b.w.slice(0, -s.length), neg: b.neg, suffix: s });
        // عملتهولك: an object and a dative
        for (const s2 of PRON_SUFFIX) {
          const w2 = b.w.slice(0, -s.length);
          if (w2.endsWith(s2) && w2.length - s2.length >= 2) out.push({ w: w2.slice(0, -s2.length), neg: b.neg, suffix: s2 + s });
        }
      }
    }
  }
  return out;
}

/** A noun as the lexicon spells it: without و/ف, ال, ب, ل, ك and a possessive. */
function nounForms(word) {
  const out = new Set([word]);
  for (const p of NOUN_PREFIX) if (word.startsWith(p) && word.length - p.length >= 3) out.add(word.slice(p.length));
  for (const w of [...out]) for (const s of NOUN_SUFFIX) if (w.endsWith(s) && w.length - s.length >= 3) out.add(w.slice(0, -s.length));
  // تشغيله / اعادته: ة became ه, and a suffix turns it back into ت
  for (const w of [...out]) if (/ت(?:ه|ها|هم|ك|ي)$/.test(w)) out.add(w.replace(/ت(?:ه|ها|هم|ك|ي)$/, "ه"));
  return [...out];
}

/** Lexicon entries a word could be. */
function lookup(word) {
  // A word that is itself a state or a known non-claim is not read through a
  // clitic: فشلت is "it failed", not ف + شلت ("I removed").
  if (STATES.has(word) || STATE_OTHER.has(word) || T_SAFE.has(word) || TERMS.has(word)) return [];
  const hits = [];
  for (const f of verbForms(word)) {
    for (const e of LEX.get(f.w) || []) {
      if (NOUN_ROLES.has(e.role)) continue;
      hits.push({ ...e, form: f.w, negForm: f.neg, suffix: f.suffix });
    }
  }
  for (const f of nounForms(word)) {
    for (const e of LEX.get(f) || []) if (NOUN_ROLES.has(e.role)) hits.push({ ...e, form: f, negForm: false, suffix: "" });
  }
  return hits;
}

function isNegWord(w) {
  if (EN_NEG.has(w) || /n't$/.test(w)) return true;
  if (NEG.has(w)) return true;
  // وما / ولا / فمش
  return CONJ.test(w) && NEG.has(w.slice(1));
}

/** Is the word at position `i` of `words` negated (by a particle just before it)? */
function negatedWord(words, i) {
  for (let k = 0; k < i - NEG_WINDOW; k++) {
    const w = words[k].w;
    if (NEG_CLAUSE.has(w) || (CONJ.test(w) && NEG_CLAUSE.has(w.slice(1)))) return true;
  }
  for (let k = Math.max(0, i - NEG_WINDOW); k < i; k++) {
    const w = words[k].w;
    if (isNegWord(w)) return true;
    for (const [a, b] of NEG_PAIRS) if (w === a && words[k + 1] && words[k + 1].w === b && k + 1 < i) return true;
  }
  return false;
}

/** Is anything at character offset `idx` of this clause negated? */
function negatedAt(clause, idx) {
  const ws = wordsOf(clause);
  let i = ws.findIndex((x) => x.idx >= idx);
  if (i < 0) i = ws.length;
  return negatedWord(ws, i);
}

/**
 * The Arabic action claims in one normalized clause, in order:
 * [{role, en, generic, idx, word, negated, addressee}]. An action noun after
 * a marker (تم / جاري / هيتم + إعادة تشغيل) gives the marker its concept.
 */
function claimsIn(clause) {
  const ws = wordsOf(clause);
  const out = [];
  for (let i = 0; i < ws.length; i++) {
    const { w, idx } = ws[i];
    if (!AR_WORD.test(w)) continue;
    const hits = lookup(w);
    if (!hits.length) continue;
    // The word as it stands wins: an exact verb form, then a noun (إعادة is
    // the noun, not أعاد + a suffix), then a verb read through a suffix.
    const h =
      hits.find((x) => !NOUN_ROLES.has(x.role) && !x.suffix) ||
      hits.find((x) => NOUN_ROLES.has(x.role)) ||
      hits[0];
    const negated = h.negForm || negatedWord(ws, i);
    out.push({ role: h.role, en: h.en, generic: h.generic, idx, word: w, negated, addressee: ADDRESSEE.has(h.suffix), alt: hits, pos: i });
  }
  // Participles ("أنا عاملة ده", "مشغّلاه") and "أنا شغالة عليه" ("I'm on
  // it"): a claim of a result, or of work in progress, in the first person.
  // Not in a question ("عاملة إيه؟").
  if (!/[؟?]\s*$/.test(String(clause))) {
    for (let i = 0; i < ws.length; i++) {
      const { w, idx } = ws[i];
      if (!AR_WORD.test(w) || out.some((c) => c.pos === i)) continue;
      const p = participle(w);
      const next = ws[i + 1] ? ws[i + 1].w : "";
      if (p) {
        if (p.bare && !firstPersonBefore(ws, i)) continue;
        if (PTC_NOT_AFTER.has(next)) continue;
        out.push({ role: "ptc1", en: p.en, generic: p.en === "do", idx, word: w, negated: negatedWord(ws, i), addressee: false, alt: [], pos: i });
        continue;
      }
      // «أنا شغالة عليه / فيه»: working on it.
      const bare = CONJ.test(w) ? w.slice(1) : w;
      if (/^شغال(?:ه|ين)?$/.test(bare) && firstPersonBefore(ws, i) && /^(?:علي|عليه|عليها|عليهم|في|فيه|فيها|فيهم)$/.test(next)) {
        out.push({ role: "prog1", en: "do", generic: true, idx, word: w, negated: negatedWord(ws, i), addressee: false, alt: [], pos: i });
      }
    }
    out.sort((a, b) => a.pos - b.pos);
  }
  // A generic marker (تم، جاري، هيتم، عملت) followed by an action noun or verb
  // takes that action's concept; the noun is then part of it.
  for (let k = 0; k < out.length; k++) {
    const c = out[k];
    if (c.absorbed) continue;
    let next = out[k + 1];
    if (c.generic && next && next.pos - c.pos <= 2 && !next.generic) {
      c.en = next.en;
      c.generic = false;
      c.object = true;
      next.absorbed = true;
      next = out[k + 2];
      c.pos = out[k + 1].pos;
    }
    // An action noun right after an action is its object: إعادة تشغيل is one
    // restart, عملت تحديث one update.
    if (!c.generic && next && next.role === "noun" && next.pos - c.pos === 1) next.absorbed = true;
  }
  return out.filter((c) => !c.absorbed);
}

/** Does the clause open with an action noun ("إعادة تشغيل أودو.")? */
function nounFirst(clause) {
  const ws = wordsOf(clause);
  let i = 0;
  while (i < ws.length && (OPENERS.has(ws[i].w) || /^(ok|okay|sure|alright|right)$/.test(ws[i].w))) i++;
  if (i >= ws.length || !AR_WORD.test(ws[i].w)) return null;
  const hits = lookup(ws[i].w).filter((h) => NOUN_ROLES.has(h.role));
  return hits.length ? { en: hits[0].en, idx: ws[i].idx, word: ws[i].w } : null;
}

/** States in a clause: [{sign, strong, idx, word}] (sign flipped when negated). */
function statesIn(clause) {
  const ws = wordsOf(clause);
  const out = [];
  for (let i = 0; i < ws.length; i++) {
    const w = CONJ.test(ws[i].w) && !STATES.has(ws[i].w) && !STATE_OTHER.has(ws[i].w) ? ws[i].w.slice(1) : ws[i].w;
    const base = STATES.get(w);
    if (base === undefined && !STATE_OTHER.has(w)) continue;
    out.push({ word: w, idx: ws[i].idx, alive: base !== undefined, base: base || 0, sign: base === undefined ? 0 : negatedWord(ws, i) ? -base : base, strong: STRONG.has(w) });
  }
  return out;
}

/** The status terms a clause is about, as the snapshot's English names. */
function termsIn(clause) {
  const out = [];
  for (const { w } of wordsOf(clause)) {
    if (!AR_WORD.test(w)) continue;
    for (const f of [w, ...(CONJ.test(w) ? [w.slice(1)] : []), ...nounForms(w)]) {
      const t = TERMS.get(f) || TERMS.get("ال" + f);
      if (t) {
        out.push(t);
        break;
      }
    }
  }
  return out;
}

function hasPhrase(clause, list) {
  const c = " " + wordsOf(clause).map((x) => x.w).join(" ") + " ";
  return list.some((p) => c.includes(" " + p + " "));
}

function hedged(clause) {
  if (/؟\s*$/.test(clause)) return true;
  if (hasPhrase(clause, HEDGE_PHRASES)) return true;
  return wordsOf(clause).some(({ w }) => HEDGE.has(w) || (CONJ.test(w) && HEDGE.has(w.slice(1))));
}

function pronounSubject(clause) {
  const ws = wordsOf(clause);
  if (!ws.length) return false;
  let w = ws[0].w;
  if (CONJ.test(w) && PRONOUN.has(w.slice(1))) w = w.slice(1);
  return PRONOUN.has(w) || hasPhrase(ws.slice(0, 2).map((x) => x.w).join(" "), PRONOUN_PHRASES);
}

/** Does the clause open with a confirmation ("تمام." / "خلاص")? */
function confirmFirst(clause) {
  const ws = wordsOf(clause);
  return ws.length > 0 && ws.length <= 4 && CONFIRM.has(ws[0].w);
}

/** "حالاً" / "دلوقتي حالاً": a promise of immediacy (not negated). */
function nowMarker(clause) {
  const ws = wordsOf(clause);
  if (hasPhrase(clause, NOW_PHRASES)) return true;
  return ws.some((x, i) => NOW.has(x.w) && !negatedWord(ws, i));
}

/** "JOYA AI قال/ردّ/اقترح ..." (not negated), or "رده إن ...". */
function attribution(clause) {
  const ws = wordsOf(clause);
  for (let i = 0; i < ws.length; i++) {
    if (!/^(joya|جويا|جوية)$/.test(ws[i].w)) continue;
    for (let k = i + 1; k <= i + 4 && k < ws.length; k++) {
      const w = ws[k].w;
      const forms = verbForms(w);
      const hit = forms.find((f) => ATTR_VERBS.has(f.w));
      if (hit && !hit.neg && !negatedWord(ws, k)) return { idx: ws[k].idx, word: w };
    }
  }
  const m = ANSWER_IS_AR.exec(clause);
  return m && !negatedAt(clause, m.index) ? { idx: m.index, word: m[0] } : null;
}

/**
 * Fail closed: an Arabic word shaped like a past-tense result ("…ت" — I did /
 * she did; "ات…" — it got done) that the lexicon does not know, and that is not
 * negated. The desk may not say what it cannot read.
 */
function unparsed(clause) {
  const ws = wordsOf(clause);
  for (let i = 0; i < ws.length; i++) {
    const w0 = ws[i].w;
    if (!AR_WORD.test(w0) || lookup(w0).length || participle(w0)) continue;
    const forms = verbForms(w0);
    if (forms.some((f) => f.neg)) continue; // ما…ش: a negated result
    // A verb's object suffix (مسحتها) is read through; a possessive (موافقتك,
    // رسالته: the ة of a noun is a ت before a suffix) is not a verb.
    const cands = [...new Set(forms.filter((f) => !f.suffix || VERB_SUFFIX.has(f.suffix)).map((f) => f.w))].filter((w) => !(/ت$/.test(w) && w !== w0 && (/^م/.test(w) && w.length >= 5 || CONSTRUCT.has(w))));
    const known = (w) => T_SAFE.has(w) || [...AT_SAFE].some((p) => w.startsWith(p)) || STATES.has(w) || STATE_OTHER.has(w) || TERMS.has(w) || AR_NUM[w] !== undefined || /بايت$/.test(w);
    if (cands.some(known)) continue;
    // An m-participle with an object after the feminine -ا (مغيّراه، مركّباها):
    // "I've done it", in a form the table does not know.
    const bareW = CONJ.test(w0) ? w0.slice(1) : w0;
    if (/^م\p{L}{3,5}(?:اه|اها|اهم|اهولك)$/u.test(bareW) && !negatedWord(ws, i)) return { idx: ws[i].idx, word: w0 };
    const pastT = cands.some((w) => w.length >= 3 && w.length <= 7 && /ت$/.test(w) && !/ات$/.test(w) && !/^ال/.test(w));
    const passive = cands.some((w) => w.length >= 5 && /^ات/.test(w));
    if ((pastT || passive) && !negatedWord(ws, i)) return { idx: ws[i].idx, word: w0 };
  }
  return null;
}

/** Arabic content words (for a summary's anchors): base forms, three letters or more. */
const AR_STOP = set("جويا جويا لازم المفروض ينصح بينصح نصح يقترح بيقترح اقترح اقتراح الافضل احسن يستحسن يفضل بيفضل محتاج تعمل ان انه في من الي علي عن مع ده دي دول هو هي انا احنا انت انتي هما اللي الذي التي كان كانت يكون بس لكن او ولا كمان برضه ايضا لسه دلوقتي الان عشان لان علشان اي ايه ازاي امتي فين كل بعض غير حاجه حاجات يعني طيب تمام");
function contentWords(text) {
  const out = [];
  for (const { w } of wordsOf(normalize(String(text || "").toLowerCase()))) {
    if (!AR_WORD.test(w)) continue;
    const forms = nounForms(w);
    const base = forms.reduce((a, b) => (b.length < a.length ? b : a), w);
    if (base.length < 3 || AR_STOP.has(base) || AR_STOP.has(w)) continue;
    const hit = lookup(w).find((h) => !h.generic);
    out.push(hit ? { concept: hit.en } : { word: TERMS.get(base) || base });
  }
  return out;
}

/* --------------------------------------------------- the transcript side -- */

// What transcription models write for silence in Arabic: subtitle credits and
// channel outros (from the video subtitles they were trained on). The credits
// are dropped always -- nobody says them to JOYA AI.
const CREDITS_AR = new RegExp(
  [
    "نانسي\\s+قنقر",
    "اشتركوا?\\s+(?:في\\s+)?(?:ال)?قناه",
    "الاشتراك\\s+(?:في\\s+)?(?:ال)?قناه",
    "لا\\s+تنسوا?\\s+(?:ال)?اشتراك",
    "تم\\s+التفريغ",
    "تفريغ\\s+(?:بواسطه|من|و)",
    "ترجمه\\s+(?:و\\s*)?(?:تدقيق|بواسطه|من|نانسي)",
    "^ترجمه\\s*[:\\-]",
  ].join("|"),
  "u"
);
// "ترجمة <first name> <last name>" is a credit too -- but so could be a real
// request ("ترجمة الرسالة دي"), so only on a short or quiet clip.
const CREDIT_NAME_AR = /^(?:ترجمه|سبتايتل|الترجمه)\s+\p{L}+\s+\p{L}+$/u;
// Said to JOYA AI only by mistake -- dropped when the clip was short or quiet.
const SILENCE_AR = [
  "ترجمه",
  "الترجمه",
  "موسيقي",
  "موسيقي هادئه",
  "شكرا",
  "شكرا جزيلا",
  "شكرا لكم",
  "شكرا للمشاهده",
  "شكرا علي المشاهده",
  "شكرا لحسن الاستماع",
  "شكرا للاستماع",
  "السلام عليكم",
  "السلام عليكم ورحمه الله",
  "السلام عليكم ورحمه الله وبركاته",
  "مع السلامه",
  "الي اللقاء",
  "اه",
  "امم",
  "همم",
  "صمت",
  "تصفيق",
  "باي",
  "يلا",
].map(normalize);

module.exports = {
  normalize,
  digits,
  hasArabic,
  isArabic,
  scriptOf,
  wordsOf,
  uni,
  joinDigits,
  numberWords,
  lookup,
  participle,
  claimsIn,
  nounFirst,
  statesIn,
  termsIn,
  hedged,
  pronounSubject,
  confirmFirst,
  nowMarker,
  attribution,
  unparsed,
  negatedAt,
  isNegWord,
  contentWords,
  HANDOFF_AR,
  HANDOFF_STEMS,
  HANDOFF_AR_FUTURE,
  OFFER_AR,
  ANSWER_PROMISE_AR,
  RECOMMEND_AR,
  REPLY_RECOMMEND_AR,
  NEEDS_APPROVAL_AR,
  MENTIONS_APPROVAL_AR,
  CREDITS_AR,
  CREDIT_NAME_AR,
  SILENCE_AR,
  JOYA,
  LEX,
};
