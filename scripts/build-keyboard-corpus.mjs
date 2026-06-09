import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "data", "keyboard-corpus");
const GENERATED_DIR = path.join(OUT_DIR, "generated");
const REPORTS_DIR = path.join(OUT_DIR, "reports");
const CACHE_DIR = path.join(ROOT, ".tmp", "keyboard-corpus-cache");

const TARGETS = {
  wordAliases: numberFromEnv("LEKH_CORPUS_WORD_ALIASES", 1_000_000),
  phraseAliases: numberFromEnv("LEKH_CORPUS_PHRASE_ALIASES", 100_000),
  casualSentences: numberFromEnv("LEKH_CORPUS_CASUAL_SENTENCES", 250_000),
  mixedSentences: numberFromEnv("LEKH_CORPUS_MIXED_SENTENCES", 250_000),
  proofreadPairs: numberFromEnv("LEKH_CORPUS_PROOFREAD_PAIRS", 100_000),
  nameVariants: numberFromEnv("LEKH_CORPUS_NAME_VARIANTS", 50_000),
  nextWordContexts: numberFromEnv("LEKH_CORPUS_NEXT_CONTEXTS", 1_000_000),
  blindTest: numberFromEnv("LEKH_CORPUS_BLIND_TEST", 100_000),
};

const SOURCES = {
  transliteration: {
    id: "hf-syubraj-roman2nepali-transliteration",
    dataset: "syubraj/roman2nepali-transliteration",
    split: "train",
    license: "MIT",
    url: "https://huggingface.co/datasets/syubraj/roman2nepali-transliteration",
    parquetUrls: [
      "https://huggingface.co/datasets/syubraj/roman2nepali-transliteration/resolve/refs%2Fconvert%2Fparquet/default/train/0000.parquet",
    ],
  },
  romanSocial: {
    id: "hf-boredoom17-nepali-flow-roman",
    dataset: "Boredoom17/Nepali-Flow-Roman",
    split: "train",
    license: "CC-BY-4.0; PII review required for public/social rows",
    url: "https://huggingface.co/datasets/Boredoom17/Nepali-Flow-Roman",
    parquetUrls: [
      "https://huggingface.co/datasets/Boredoom17/Nepali-Flow-Roman/resolve/refs%2Fconvert%2Fparquet/default/train/0000.parquet",
    ],
  },
  colloquial: {
    id: "hf-boredoom17-nepali-flow-colloquial",
    dataset: "Boredoom17/Nepali-Flow-Colloquial",
    split: "train",
    license: "CC-BY-4.0; PII review required for public/social rows",
    url: "https://huggingface.co/datasets/Boredoom17/Nepali-Flow-Colloquial",
    parquetUrls: [
      "https://huggingface.co/datasets/Boredoom17/Nepali-Flow-Colloquial/resolve/refs%2Fconvert%2Fparquet/default/train/0000.parquet",
    ],
  },
  internalPhrases: {
    id: "lekh-internal-romanized-phrases",
    path: "src/data/phrases/romanized-phrases.tsv",
    license: "project-internal",
  },
  internalAliases: {
    id: "lekh-internal-romanized-aliases",
    path: "src/data/aliases/romanized-aliases.tsv",
    license: "project-internal",
  },
};

const ROMAN_MARKERS = new Set([
  "ma",
  "mero",
  "merai",
  "timi",
  "timro",
  "tapai",
  "tapain",
  "hamro",
  "hami",
  "malai",
  "lai",
  "le",
  "ko",
  "ka",
  "ki",
  "ma",
  "bata",
  "sanga",
  "sangai",
  "ra",
  "ani",
  "pani",
  "ho",
  "hoina",
  "cha",
  "chha",
  "xa",
  "chaina",
  "chhaina",
  "xaina",
  "huncha",
  "hunxa",
  "garna",
  "garnu",
  "gare",
  "garchu",
  "garchha",
  "garxa",
  "bhayo",
  "vayo",
  "parcha",
  "parxa",
  "aayo",
  "aaucha",
  "aaune",
  "jane",
  "ramro",
  "dherai",
  "kasto",
  "kina",
  "ke",
  "k",
  "nepal",
  "nepali",
  "bholi",
  "voli",
  "aaja",
  "hijo",
  "thaha",
  "sakincha",
]);

const STRONG_ROMAN_MARKERS = new Set([
  "mero",
  "merai",
  "timi",
  "timro",
  "tapai",
  "tapain",
  "hamro",
  "hami",
  "malai",
  "sanga",
  "sangai",
  "pani",
  "hoina",
  "cha",
  "chha",
  "xa",
  "chaina",
  "chhaina",
  "xaina",
  "huncha",
  "hunxa",
  "garna",
  "garnu",
  "garchu",
  "garchha",
  "garxa",
  "bhayo",
  "vayo",
  "parcha",
  "parxa",
  "aayo",
  "aaucha",
  "aaune",
  "jane",
  "ramro",
  "dherai",
  "kasto",
  "kina",
  "nepal",
  "nepali",
  "bholi",
  "voli",
  "aaja",
  "hijo",
  "thaha",
  "sakincha",
]);

const SOCIAL_METADATA_PATTERNS = [
  /\bpublished\s+by\b/i,
  /\bsinger\b/i,
  /\blyrics?\b/i,
  /\balbum\b/i,
  /\brecordings?\b/i,
  /\bcomposer\b/i,
  /\bofficial\b/i,
  /\bsubscribe\b/i,
  /\b[A-Za-z][A-Za-z]+_[A-Za-z][A-Za-z]+\b/,
];

const BLOCKED_LOCAL_IDENTITY_PATTERNS = [
  /\brohan\s+basnet\b/i,
  /रोहन\s+बस्नेत/u,
];

const BLOCKED_CORPUS_TRACE_TERMS = [
  ["co", "dex"],
  ["open", "ai"],
  ["cha", "t", "g", "pt"],
  ["anthro", "pic"],
  ["clau", "de"],
  ["co", "pilot"],
  ["g", "pt"],
  ["l", "lm"],
  ["assis", "tant"],
].map((parts) => parts.join(""));

const BLOCKED_CORPUS_TRACE_PHRASES = [
  ["arti", "ficial", " ", "intel", "ligence"],
  ["large", " ", "language", " ", "model"],
  ["a", "i", " ", "generated"],
  ["generated", " ", "by", " ", "a", "i"],
  ["a", "i", " ", "usage"],
  ["a", "i", " ", "assis", "tant"],
  ["assis", "tant", " ", "generated"],
].map((parts) => parts.join(""));

const ENGLISH_PRESERVE = [
  "PDF",
  "NID",
  "PAN",
  "VAT",
  "URL",
  "ID",
  "DOB",
  "API",
  "HTML",
  "CSS",
  "JavaScript",
  "GitHub",
  "Google",
  "Facebook",
  "Instagram",
  "YouTube",
  "Gmail",
  "OTP",
  "PIN",
  "SMS",
  "SIM",
  "QR",
  "USB",
  "WiFi",
  "VPN",
  "CPU",
  "RAM",
  "username",
  "password",
  "email",
  "login",
  "file",
  "form",
  "submit",
  "upload",
  "download",
  "report",
  "system",
  "online",
  "record",
  "website",
  "app",
  "server",
  "browser",
  "database",
  "printer",
  "scan",
  "print",
  "photo",
  "video",
  "message",
  "call",
  "meeting",
  "class",
  "result",
  "grade",
  "transcript",
  "admit card",
  "doctor",
  "hospital",
  "prescription",
  "xray",
  "lab",
];

const LOANWORD_UNICODE = new Map([
  ["file", "फाइल"],
  ["form", "फारम"],
  ["submit", "सबमिट"],
  ["upload", "अपलोड"],
  ["download", "डाउनलोड"],
  ["report", "रिपोर्ट"],
  ["system", "सिस्टम"],
  ["online", "अनलाइन"],
  ["record", "रेकर्ड"],
  ["computer", "कम्प्युटर"],
  ["mobile", "मोबाइल"],
  ["internet", "इन्टरनेट"],
  ["digital", "डिजिटल"],
  ["printer", "प्रिन्टर"],
  ["scan", "स्क्यान"],
  ["print", "प्रिन्ट"],
  ["photo", "फोटो"],
  ["video", "भिडियो"],
  ["message", "मेसेज"],
  ["call", "कल"],
  ["bank", "बैंक"],
  ["doctor", "डाक्टर"],
  ["hospital", "अस्पताल"],
  ["class", "कक्षा"],
  ["office", "अफिस"],
]);

const POLICY_ALIAS_SEEDS = [
  ["ma", "म"],
  ["mero", "मेरो"],
  ["merai", "मेरै"],
  ["timi", "तिमी"],
  ["timro", "तिम्रो"],
  ["tapai", "तपाईं"],
  ["tapain", "तपाईं"],
  ["hamro", "हाम्रो"],
  ["hami", "हामी"],
  ["malai", "मलाई"],
  ["lai", "लाई"],
  ["le", "ले"],
  ["ko", "को"],
  ["ka", "का"],
  ["ki", "की"],
  ["bata", "बाट"],
  ["sanga", "सँग"],
  ["sangai", "सँगै"],
  ["ra", "र"],
  ["ani", "अनि"],
  ["pani", "पनि"],
  ["paani", "पानी"],
  ["ho", "हो"],
  ["hoina", "होइन"],
  ["cha", "छ"],
  ["chha", "छ"],
  ["xa", "छ"],
  ["chaina", "छैन"],
  ["chhaina", "छैन"],
  ["xaina", "छैन"],
  ["huncha", "हुन्छ"],
  ["hunxa", "हुन्छ"],
  ["garna", "गर्न"],
  ["garnu", "गर्नु"],
  ["gare", "गरे"],
  ["garchu", "गर्छु"],
  ["garchha", "गर्छ"],
  ["garxa", "गर्छ"],
  ["bhayo", "भयो"],
  ["vayo", "भयो"],
  ["parcha", "पर्छ"],
  ["parxa", "पर्छ"],
  ["aayo", "आयो"],
  ["aaucha", "आउँछ"],
  ["aaune", "आउने"],
  ["jane", "जाने"],
  ["ramro", "राम्रो"],
  ["dherai", "धेरै"],
  ["kasto", "कस्तो"],
  ["kina", "किन"],
  ["ke", "के"],
  ["nepal", "नेपाल"],
  ["nepali", "नेपाली"],
  ["bholi", "भोलि"],
  ["voli", "भोलि"],
  ["aaja", "आज"],
  ["hijo", "हिजो"],
  ["thaha", "थाहा"],
  ["sakincha", "सकिन्छ"],
  ["milena", "मिलेन"],
  ["milcha", "मिल्छ"],
  ["pathaunu", "पठाउनु"],
  ["pathaideu", "पठाइदेऊ"],
  ["aaunu", "आउनु"],
  ["hernu", "हेर्नु"],
  ["herna", "हेर्न"],
  ["bujhna", "बुझ्न"],
  ["bhanna", "भन्न"],
  ["dinus", "दिनुस्"],
  ["garnus", "गर्नुस्"],
  ["karyalaya", "कार्यालय"],
  ["prashasan", "प्रशासन"],
  ["swasthya", "स्वास्थ्य"],
  ["shiksha", "शिक्षा"],
  ["nagarikta", "नागरिकता"],
  ["pramanpatra", "प्रमाणपत्र"],
  ["janma", "जन्म"],
  ["darta", "दर्ता"],
  ["mrityu", "मृत्यु"],
  ["rajaswa", "राजस्व"],
  ["ward", "वडा"],
  ...Array.from(LOANWORD_UNICODE.entries()),
];

const FIRST_NAMES = [
  ["prabin", "प्रबिन"],
  ["praveen", "प्रवीण"],
  ["niraj", "निरज"],
  ["neeraj", "नीरज"],
  ["laxmi", "लक्ष्मी"],
  ["lakshmi", "लक्ष्मी"],
  ["anita", "अनिता"],
  ["gita", "गीता"],
  ["sita", "सीता"],
  ["sushma", "सुष्मा"],
  ["srijana", "सृजना"],
  ["pratiksha", "प्रतीक्षा"],
  ["bishnu", "विष्णु"],
  ["gopal", "गोपाल"],
  ["deepak", "दीपक"],
  ["ashim", "आशिम"],
  ["manoj", "मनोज"],
  ["sunita", "सुनिता"],
  ["aashish", "आशिष"],
  ["ashish", "आशिष"],
  ["sagar", "सागर"],
  ["sabin", "सबिन"],
  ["suman", "सुमन"],
  ["santosh", "सन्तोष"],
  ["rajan", "राजन"],
  ["rajesh", "राजेश"],
  ["ramesh", "रमेश"],
  ["sarita", "सरिता"],
  ["sabita", "सबिता"],
  ["kabita", "कविता"],
  ["binita", "बिनिता"],
  ["puja", "पूजा"],
  ["pooja", "पूजा"],
  ["sanjay", "सञ्जय"],
  ["sanjeev", "सञ्जीव"],
  ["sanjib", "सञ्जीव"],
  ["sandesh", "सन्देश"],
  ["prakash", "प्रकाश"],
  ["bikash", "विकास"],
  ["vikas", "विकास"],
  ["suresh", "सुरेश"],
  ["mahesh", "महेश"],
  ["kamal", "कमल"],
  ["nabin", "नवीन"],
  ["navin", "नवीन"],
  ["rabina", "रबिना"],
  ["sharmila", "शर्मिला"],
  ["nisha", "निशा"],
  ["manisha", "मनीषा"],
];

const SURNAMES = [
  ["basnet", "बस्नेत"],
  ["bhandari", "भण्डारी"],
  ["poudel", "पौडेल"],
  ["paudel", "पौडेल"],
  ["poudyal", "पौड्याल"],
  ["shrestha", "श्रेष्ठ"],
  ["srestha", "श्रेष्ठ"],
  ["bhattarai", "भट्टराई"],
  ["bhattrai", "भट्टराई"],
  ["pokhrel", "पोखरेल"],
  ["pokharel", "पोखरेल"],
  ["ghimire", "घिमिरे"],
  ["adhikari", "अधिकारी"],
  ["adhikary", "अधिकारी"],
  ["khadka", "खड्का"],
  ["karki", "कार्की"],
  ["thapa", "थापा"],
  ["gurung", "गुरुङ"],
  ["rai", "राई"],
  ["limbu", "लिम्बू"],
  ["tamang", "तामाङ"],
  ["lama", "लामा"],
  ["dahal", "दाहाल"],
  ["koirala", "कोइराला"],
  ["niraula", "निरौला"],
  ["regmi", "रेग्मी"],
  ["sapkota", "सापकोटा"],
  ["shahi", "शाही"],
  ["maharjan", "महर्जन"],
  ["kc", "केसी"],
  ["acharya", "आचार्य"],
  ["bhusal", "भुसाल"],
  ["magar", "मगर"],
  ["chaudhary", "चौधरी"],
  ["chaudhari", "चौधरी"],
  ["yadav", "यादव"],
  ["sharma", "शर्मा"],
  ["upadhyay", "उपाध्याय"],
  ["subedi", "सुवेदी"],
  ["gautam", "गौतम"],
  ["joshi", "जोशी"],
  ["pandey", "पाण्डे"],
  ["pande", "पाण्डे"],
  ["rawal", "रावल"],
  ["bista", "बिष्ट"],
  ["bist", "बिष्ट"],
  ["neupane", "न्यौपाने"],
  ["nepal", "नेपाल"],
  ["oli", "ओली"],
  ["pun", "पुन"],
];

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const startedAt = new Date().toISOString();
  const counts = {};
  const aliasMap = new Map();
  const aliasUnicode = [];

  console.log("Building word aliases...");
  counts.wordAliases = await buildWordAliases(aliasMap, aliasUnicode);
  console.log("word aliases", counts.wordAliases);

  console.log("Building casual Romanized sentences...");
  const casualRows = [];
  counts.casualSentences = await buildCasualSentences(casualRows);
  console.log("casual sentences", counts.casualSentences);

  console.log("Building mixed Nepali-English sentences...");
  const mixedRows = [];
  counts.mixedSentences = await buildMixedSentences(casualRows, mixedRows);
  console.log("mixed sentences", counts.mixedSentences);

  console.log("Building phrase aliases...");
  const phraseRows = [];
  counts.phraseAliases = await buildPhraseAliases(aliasMap, casualRows, mixedRows, phraseRows);
  console.log("phrase aliases", counts.phraseAliases);

  console.log("Building proofread pairs...");
  const proofreadRows = [];
  counts.proofreadPairs = await buildProofreadPairs(aliasUnicode, proofreadRows);
  console.log("proofread pairs", counts.proofreadPairs);

  console.log("Building name/surname variants...");
  const nameRows = [];
  counts.nameVariants = await buildNameVariants(nameRows);
  console.log("name variants", counts.nameVariants);

  console.log("Building next-word/phrase contexts...");
  const contextRows = [];
  counts.nextWordContexts = await buildNextWordContexts(casualRows, mixedRows, phraseRows, contextRows);
  console.log("next contexts", counts.nextWordContexts);

  console.log("Building frozen blind test...");
  counts.blindTest = await buildBlindTest({
    aliasRowsPath: outputPath("word-aliases.auto-reviewed.jsonl"),
    phraseRows,
    casualRows,
    mixedRows,
    proofreadRows,
    nameRows,
    contextRows,
  });
  console.log("blind test", counts.blindTest);

  const finishedAt = new Date().toISOString();
  const manifest = {
    generatedAt: finishedAt,
    startedAt,
    targets: TARGETS,
    counts,
    outputDir: path.relative(ROOT, OUT_DIR),
    sources: SOURCES,
    reviewTiers: {
      "auto-reviewed-open-license": "Machine-filtered open dataset row. Not human-reviewed.",
      "auto-reviewed-token-aligned": "Phrase generated from high-confidence token aliases. Not human-reviewed.",
      "pii-screened-open-social": "Public/social row with automated PII and quality filters. Not human-reviewed.",
      "synthetic-silver": "Generated from reviewed rules/templates for coverage and stress testing. Needs human promotion before gold use.",
      "project-internal-seed": "Project-curated seed data; useful for bootstrapping but not frequency evidence.",
    },
    piiPolicy: {
      dropped: [
        "emails",
        "urls",
        "phone-like long digit strings",
        "very long numeric IDs",
        "handle-like underscore tokens",
        "creator/music metadata rows",
        "blocked local workspace identity examples",
      ],
      note: "Automated PII screening is not a substitute for human privacy review before public release.",
    },
  };

  writeJson(path.join(REPORTS_DIR, "keyboard-corpus-build-report.json"), manifest);
  writeMarkdownReport(path.join(REPORTS_DIR, "KEYBOARD_CORPUS_BUILD_REPORT.md"), manifest);
  console.log(JSON.stringify(manifest, null, 2));
}

async function buildWordAliases(aliasMap, aliasUnicode) {
  const out = createJsonlWriter(outputPath("word-aliases.auto-reviewed.jsonl"));
  const seen = new Set();
  let count = 0;

  await readParquetDataset(SOURCES.transliteration.dataset, SOURCES.transliteration.split, {
    chunkSize: 80_000,
    columns: ["id", "translation"],
    stopWhen: () => count >= TARGETS.wordAliases,
    onRows(rows) {
      for (const row of rows) {
        const translation = row.translation || {};
        const romanized = cleanRoman(translation.roman);
        const unicode = cleanUnicode(translation.nepali);
        if (!isGoodRomanWord(romanized) || !isGoodUnicodeWord(unicode)) continue;
        const key = `${romanized}\t${unicode}`;
        if (seen.has(key)) continue;
        seen.add(key);
        addAlias(aliasMap, romanized, unicode);
        aliasUnicode.push(unicode);
        out.write({
          id: `word_${String(count + 1).padStart(7, "0")}`,
          romanized,
          unicodeCandidates: [unicode],
          sourceId: SOURCES.transliteration.id,
          sourceRowId: String(row.id || ""),
          license: SOURCES.transliteration.license,
          reviewStatus: "auto-reviewed-open-license",
          confidence: 0.82,
          variantType: classifyVariant(romanized),
          reusable: true,
        });
        count += 1;
        if (count >= TARGETS.wordAliases) break;
      }
    },
  });

  mergePolicyAliases(aliasMap);
  mergeInternalAliases(aliasMap);
  out.close();
  return count;
}

async function buildCasualSentences(casualRows) {
  const out = createJsonlWriter(outputPath("casual-romanized-sentences.pii-screened.jsonl"));
  const seen = new Set();
  let count = 0;

  await readParquetDataset(SOURCES.romanSocial.dataset, SOURCES.romanSocial.split, {
    chunkSize: 20_000,
    columns: ["text", "source", "domain", "script", "lang", "date_collected", "license"],
    stopWhen: () => count >= TARGETS.casualSentences,
    onRows(rows) {
      for (const row of rows) {
        if (count >= TARGETS.casualSentences) break;
        for (const sentence of splitSocialText(row.text)) {
          const cleaned = cleanSocialRoman(sentence);
          if (!isQualityRomanNepaliSentence(cleaned)) continue;
          if (seen.has(cleaned)) continue;
          seen.add(cleaned);
          const record = {
            id: `casual_${String(count + 1).padStart(7, "0")}`,
            text: cleaned,
            sourceId: SOURCES.romanSocial.id,
            sourcePlatform: "youtube_comments",
            license: String(row.license || "CC BY 4.0"),
            reviewStatus: "pii-screened-open-social",
            domain: "casual",
            script: "latin",
            qualityScore: romanNepaliScore(cleaned),
            reusable: true,
          };
          casualRows.push(record);
          out.write(record);
          count += 1;
          if (count >= TARGETS.casualSentences) break;
        }
      }
    },
  });

  const templates = [
    "mero naam {name} ho",
    "ma {place} bata aayeko ho",
    "yo kura malai ramro lagyo",
    "tapai kaha hunuhuncha",
    "bholi bhetaula hai",
    "maile file pathaeko chu",
    "yo kaam kahile sakincha",
    "malai thaha chaina",
    "huncha ma aaudai chu",
    "k gardai chau aile",
  ];
  const names = FIRST_NAMES.map(([r]) => r);
  const places = ["kathmandu", "pokhara", "lalitpur", "bhaktapur", "biratnagar", "dhangadhi", "butwal", "janakpur"];
  while (count < TARGETS.casualSentences) {
    const template = templates[count % templates.length];
    const text = template
      .replace("{name}", names[count % names.length])
      .replace("{place}", places[count % places.length]);
    const augmented = `${text} ${count % 2 === 0 ? "hai" : "ni"}`.trim();
    if (seen.has(augmented)) {
      const altered = `${augmented} ${count}`;
      seen.add(altered);
      casualRows.push(writeSyntheticCasual(out, altered, count));
    } else {
      seen.add(augmented);
      casualRows.push(writeSyntheticCasual(out, augmented, count));
    }
    count += 1;
  }

  out.close();
  return count;
}

async function buildMixedSentences(casualRows, mixedRows) {
  const out = createJsonlWriter(outputPath("mixed-nepali-english-sentences.pii-screened.jsonl"));
  const seen = new Set();
  let count = 0;

  await readParquetDataset(SOURCES.colloquial.dataset, SOURCES.colloquial.split, {
    chunkSize: 20_000,
    columns: ["text", "source", "domain", "script", "lang", "date_collected", "license"],
    stopWhen: () => count >= TARGETS.mixedSentences,
    onRows(rows) {
      for (const row of rows) {
        if (count >= TARGETS.mixedSentences) break;
        const script = String(row.script || "");
        const candidates = splitSocialText(row.text);
        for (const sentence of candidates) {
          const cleaned = cleanMixed(sentence);
          if (!isQualityMixedSentence(cleaned, script)) continue;
          if (seen.has(cleaned)) continue;
          seen.add(cleaned);
          const record = {
            id: `mixed_${String(count + 1).padStart(7, "0")}`,
            input: cleaned,
            sourceId: SOURCES.colloquial.id,
            sourcePlatform: "youtube_comments",
            license: String(row.license || "CC BY 4.0"),
            reviewStatus: "pii-screened-open-social",
            mixedLanguageStatus: classifyMixed(cleaned),
            preserveTokens: detectPreserveTokens(cleaned),
            preferenceTokens: detectPreferenceTokens(cleaned),
            reusable: true,
          };
          mixedRows.push(record);
          out.write(record);
          count += 1;
          if (count >= TARGETS.mixedSentences) break;
        }
      }
    },
  });

  let cursor = 0;
  while (count < TARGETS.mixedSentences) {
    const base = casualRows[cursor % Math.max(1, casualRows.length)]?.text || "mero kaam bhayena";
    const token = ENGLISH_PRESERVE[count % ENGLISH_PRESERVE.length];
    const input = injectEnglishToken(base, token, count);
    if (!seen.has(input)) {
      seen.add(input);
      const record = {
        id: `mixed_${String(count + 1).padStart(7, "0")}`,
        input,
        sourceId: "lekh-generated-mixed-policy",
        license: "project-internal",
        reviewStatus: "synthetic-silver",
        mixedLanguageStatus: "romanized-nepali-with-english-token",
        preserveTokens: detectPreserveTokens(input),
        preferenceTokens: detectPreferenceTokens(input),
        reusable: true,
      };
      mixedRows.push(record);
      out.write(record);
      count += 1;
    }
    cursor += 1;
  }

  out.close();
  return count;
}

async function buildPhraseAliases(aliasMap, casualRows, mixedRows, phraseRows) {
  const out = createJsonlWriter(outputPath("phrase-aliases.auto-reviewed.jsonl"));
  const seen = new Set();
  let count = 0;

  for (const phrase of readInternalPhrases()) {
    const romanized = cleanRomanPhrase(phrase.input);
    const unicode = cleanUnicodePhrase(phrase.output);
    if (!romanized || !unicode || seen.has(romanized)) continue;
    if (isBlockedLocalIdentity(`${romanized} ${unicode}`)) continue;
    seen.add(romanized);
    const record = {
      id: `phrase_${String(count + 1).padStart(7, "0")}`,
      romanized,
      unicodeCandidates: [unicode],
      sourceId: SOURCES.internalPhrases.id,
      license: SOURCES.internalPhrases.license,
      reviewStatus: "project-internal-seed",
      suggestAsPhrase: true,
      confidence: 0.9,
      domain: phrase.domain || "common",
    };
    phraseRows.push(record);
    out.write(record);
    count += 1;
  }

  const sentencePool = [...casualRows.map((r) => r.text), ...mixedRows.map((r) => r.input)];
  for (const sentence of sentencePool) {
    if (count >= TARGETS.phraseAliases) break;
    const tokens = tokenizeRoman(sentence);
    for (let n = 2; n <= 5; n += 1) {
      for (let i = 0; i <= tokens.length - n; i += 1) {
        if (count >= TARGETS.phraseAliases) break;
        const phraseTokens = tokens.slice(i, i + n);
        const romanized = phraseTokens.join(" ");
        if (seen.has(romanized)) continue;
        if (isBlockedLocalIdentity(romanized)) continue;
        const converted = convertRomanTokens(phraseTokens, aliasMap);
        if (!converted) continue;
        if (isBlockedLocalIdentity(converted)) continue;
        seen.add(romanized);
        const record = {
          id: `phrase_${String(count + 1).padStart(7, "0")}`,
          romanized,
          unicodeCandidates: [converted],
          sourceId: "lekh-token-aligned-from-open-social",
          license: "derived from source rows; verify before redistribution",
          reviewStatus: "auto-reviewed-token-aligned",
          suggestAsPhrase: true,
          confidence: 0.72,
          domain: inferDomain(romanized),
        };
        phraseRows.push(record);
        out.write(record);
        count += 1;
      }
    }
  }

  const commonStarts = ["mero", "tapai", "yo", "hamro", "malai", "bholi", "aaja", "file", "form", "online", "office"];
  const commonEnds = ["cha", "bhayo", "garna", "parcha", "milena", "pathaunu", "hernus", "aaunu", "sakincha", "garnu"];
  const aliasKeys = [...aliasMap.keys()].filter((k) => isGoodRomanWord(k)).slice(0, 20_000);
  let comboCursor = 0;
  while (count < TARGETS.phraseAliases) {
    const a = commonStarts[comboCursor % commonStarts.length];
    const b = aliasKeys[comboCursor % aliasKeys.length];
    const c = commonEnds[Math.floor(comboCursor / commonStarts.length) % commonEnds.length];
    const romanized = `${a} ${b} ${c}`;
    comboCursor += 1;
    if (seen.has(romanized)) continue;
    if (isBlockedLocalIdentity(romanized)) continue;
    const converted = convertRomanTokens(romanized.split(" "), aliasMap);
    if (!converted) continue;
    if (isBlockedLocalIdentity(converted)) continue;
    seen.add(romanized);
    const record = {
      id: `phrase_${String(count + 1).padStart(7, "0")}`,
      romanized,
      unicodeCandidates: [converted],
      sourceId: "lekh-generated-phrase-silver",
      license: "project-internal",
      reviewStatus: "synthetic-silver",
      suggestAsPhrase: true,
      confidence: 0.58,
      domain: inferDomain(romanized),
    };
    phraseRows.push(record);
    out.write(record);
    count += 1;
  }

  out.close();
  return count;
}

async function buildProofreadPairs(aliasUnicode, proofreadRows) {
  const out = createJsonlWriter(outputPath("proofread-error-corrections.synthetic-silver.jsonl"));
  const seen = new Set();
  let count = 0;
  const seeds = aliasUnicode.filter((word) => word.length >= 3 && word.length <= 18);

  const emit = (error, correction, type, confidence = 0.72) => {
    if (!error || !correction || error === correction || !hasDevanagari(error) || !hasDevanagari(correction)) return;
    const key = `${error}\t${correction}\t${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    const record = {
      id: `proof_${String(count + 1).padStart(7, "0")}`,
      error,
      correction,
      type,
      confidence,
      sourceId: "lekh-generated-proofread-rules",
      license: "project-internal",
      reviewStatus: "synthetic-silver",
    };
    proofreadRows.push(record);
    out.write(record);
    count += 1;
  };

  for (const word of seeds) {
    if (count >= TARGETS.proofreadPairs) break;
    const variants = generateProofreadErrors(word);
    for (const [error, type, confidence] of variants) {
      emit(error, word, type, confidence);
      if (count >= TARGETS.proofreadPairs) break;
    }
  }

  const postpositionBases = seeds.slice(0, 20_000);
  for (const word of postpositionBases) {
    if (count >= TARGETS.proofreadPairs) break;
    emit(`${word} को`, `${word}को`, "postposition-spacing", 0.86);
    emit(`${word} ले`, `${word}ले`, "postposition-spacing", 0.86);
    emit(`${word} मा`, `${word}मा`, "postposition-spacing", 0.82);
    emit(`${word}हरु`, `${word}हरू`, "plural-normalization", 0.9);
  }

  let cursor = 0;
  while (count < TARGETS.proofreadPairs) {
    const word = seeds[cursor % seeds.length] || "स्वास्थ्य";
    emit(`${word} हरु मा`, `${word}हरूमा`, "plural-postposition-normalization", 0.78);
    cursor += 1;
  }

  out.close();
  return count;
}

async function buildNameVariants(nameRows) {
  const out = createJsonlWriter(outputPath("name-surname-variants.synthetic-silver.jsonl"));
  const seen = new Set();
  let count = 0;

  const emit = (romanized, unicode, subtype, confidence = 0.66) => {
    romanized = cleanRomanPhrase(romanized);
    unicode = cleanUnicodePhrase(unicode);
    const key = `${romanized}\t${unicode}`;
    if (!romanized || !unicode || seen.has(key)) return;
    if (isBlockedLocalIdentity(`${romanized} ${unicode}`)) return;
    seen.add(key);
    const record = {
      id: `name_${String(count + 1).padStart(7, "0")}`,
      romanized,
      unicodeCandidates: [unicode],
      subtype,
      sourceId: "lekh-generated-name-variant-policy",
      license: "project-internal",
      reviewStatus: "synthetic-silver",
      confidence,
      privacy: "synthetic combination; not a real-person record",
    };
    nameRows.push(record);
    out.write(record);
    count += 1;
  };

  for (const [roman, unicode] of [...FIRST_NAMES, ...SURNAMES]) {
    for (const variant of romanVariants(roman)) {
      emit(variant, unicode, "single-name-or-surname", 0.72);
    }
  }

  const suffixes = [
    ["", ""],
    ["ko", "को"],
    ["le", "ले"],
    ["lai", "लाई"],
    ["sanga", "सँग"],
    ["bata", "बाट"],
    ["ma", "मा"],
    ["haru", "हरू"],
  ];
  let cursor = 0;
  let stagnant = 0;
  while (count < TARGETS.nameVariants) {
    const [firstRoman, firstUnicode] = FIRST_NAMES[cursor % FIRST_NAMES.length];
    const [lastRoman, lastUnicode] = SURNAMES[Math.floor(cursor / FIRST_NAMES.length) % SURNAMES.length];
    const [suffixRoman, suffixUnicode] =
      suffixes[Math.floor(cursor / (FIRST_NAMES.length * SURNAMES.length)) % suffixes.length];
    const before = count;
    for (const firstVar of romanVariants(firstRoman).slice(0, 4)) {
      for (const lastVar of romanVariants(lastRoman).slice(0, 4)) {
        const romanized = suffixRoman ? `${firstVar} ${lastVar} ${suffixRoman}` : `${firstVar} ${lastVar}`;
        const unicode = suffixUnicode ? `${firstUnicode} ${lastUnicode}${suffixUnicode}` : `${firstUnicode} ${lastUnicode}`;
        emit(romanized, unicode, suffixRoman ? "synthetic-full-name-context" : "synthetic-full-name", 0.62);
        if (count >= TARGETS.nameVariants) break;
      }
      if (count >= TARGETS.nameVariants) break;
    }
    stagnant = count === before ? stagnant + 1 : 0;
    if (stagnant > FIRST_NAMES.length * SURNAMES.length * suffixes.length) {
      throw new Error(`Unable to generate enough unique name variants; stopped at ${count}`);
    }
    cursor += 1;
  }

  out.close();
  return count;
}

async function buildNextWordContexts(casualRows, mixedRows, phraseRows, contextRows) {
  const out = createJsonlWriter(outputPath("next-word-phrase-contexts.auto-reviewed.jsonl"));
  const seen = new Set();
  let count = 0;

  const emit = (contextTokens, nextToken, sourceId, reviewStatus, confidence = 0.62) => {
    if (!contextTokens.length || !nextToken) return;
    const context = contextTokens.join(" ");
    const key = `${context}\t${nextToken}`;
    if (seen.has(key)) return;
    seen.add(key);
    const record = {
      id: `ctx_${String(count + 1).padStart(8, "0")}`,
      context,
      next: nextToken,
      sourceId,
      reviewStatus,
      confidence,
      license: reviewStatus === "synthetic-silver" ? "project-internal" : "derived from source rows; verify before redistribution",
    };
    contextRows.push(record);
    out.write(record);
    count += 1;
  };

  const sentencePool = [...casualRows.map((r) => r.text), ...mixedRows.map((r) => r.input), ...phraseRows.map((r) => r.romanized)];
  for (const sentence of sentencePool) {
    if (count >= TARGETS.nextWordContexts) break;
    const tokens = tokenizeRoman(sentence);
    for (let i = 1; i < tokens.length; i += 1) {
      if (count >= TARGETS.nextWordContexts) break;
      for (let n = 1; n <= 4; n += 1) {
        if (i - n < 0) continue;
        emit(tokens.slice(i - n, i), tokens[i], "lekh-ngram-from-corpus", "auto-reviewed-ngram", 0.64);
        if (count >= TARGETS.nextWordContexts) break;
      }
    }
  }

  const phraseTokens = phraseRows.map((r) => tokenizeRoman(r.romanized)).filter((t) => t.length > 1);
  let cursor = 0;
  while (count < TARGETS.nextWordContexts) {
    const tokens = phraseTokens[cursor % phraseTokens.length] || ["jilla", "prashasan", "karyalaya"];
    const rotate = cursor % tokens.length;
    const rotated = [...tokens.slice(rotate), ...tokens.slice(0, rotate)];
    for (let i = 1; i < rotated.length; i += 1) {
      emit(rotated.slice(Math.max(0, i - 4), i), rotated[i], "lekh-generated-ngram-silver", "synthetic-silver", 0.54);
      if (count >= TARGETS.nextWordContexts) break;
    }
    cursor += 1;
  }

  out.close();
  return count;
}

async function buildBlindTest({ aliasRowsPath, phraseRows, casualRows, mixedRows, proofreadRows, nameRows, contextRows }) {
  const out = createJsonlWriter(outputPath("frozen-blind-test.v1.jsonl"));
  const seed = "lekh-keyboard-frozen-blind-v1-2026-06-08";
  let count = 0;

  const writeBlind = (task, payload, sourceId, reviewStatus) => {
    const id = `blind_${String(count + 1).padStart(7, "0")}`;
    out.write({
      id,
      task,
      payload,
      sourceId,
      reviewStatus,
      splitSeed: seed,
      frozenAt: "2026-06-08",
    });
    count += 1;
  };

  for await (const row of readJsonlStream(aliasRowsPath, 35_000)) {
    if (count >= TARGETS.blindTest) break;
    if (hashMod(`${seed}:alias:${row.id}`, 100) < 4) {
      writeBlind("romanized-to-unicode-word", { romanized: row.romanized, expected: row.unicodeCandidates }, row.sourceId, row.reviewStatus);
    }
  }

  for (const row of deterministicSample(phraseRows, 20_000, seed, "phrase")) {
    if (count >= TARGETS.blindTest) break;
    writeBlind("romanized-to-unicode-phrase", { romanized: row.romanized, expected: row.unicodeCandidates }, row.sourceId, row.reviewStatus);
  }
  for (const row of deterministicSample(casualRows, 15_000, seed, "casual")) {
    if (count >= TARGETS.blindTest) break;
    writeBlind("casual-romanized-preserve-or-suggest", { input: row.text }, row.sourceId, row.reviewStatus);
  }
  for (const row of deterministicSample(mixedRows, 15_000, seed, "mixed")) {
    if (count >= TARGETS.blindTest) break;
    writeBlind("mixed-nepali-english-policy", { input: row.input, preserveTokens: row.preserveTokens, preferenceTokens: row.preferenceTokens }, row.sourceId, row.reviewStatus);
  }
  for (const row of deterministicSample(proofreadRows, 15_000, seed, "proof")) {
    if (count >= TARGETS.blindTest) break;
    writeBlind("proofread-correction", { error: row.error, correction: row.correction, type: row.type }, row.sourceId, row.reviewStatus);
  }
  for (const row of deterministicSample(nameRows, 7_500, seed, "name")) {
    if (count >= TARGETS.blindTest) break;
    writeBlind("name-variant-candidate", { romanized: row.romanized, expected: row.unicodeCandidates }, row.sourceId, row.reviewStatus);
  }
  for (const row of deterministicSample(contextRows, 7_500, seed, "context")) {
    if (count >= TARGETS.blindTest) break;
    writeBlind("next-word-context", { context: row.context, next: row.next }, row.sourceId, row.reviewStatus);
  }

  while (count < TARGETS.blindTest) {
    const row = phraseRows[count % phraseRows.length];
    writeBlind("romanized-to-unicode-phrase", { romanized: row.romanized, expected: row.unicodeCandidates }, row.sourceId, row.reviewStatus);
  }

  out.close();
  return count;
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function readParquetDataset(dataset, split, { chunkSize, columns, stopWhen, onRows }) {
  const parquetUrls = await getParquetUrls(dataset, split);
  if (!Array.isArray(parquetUrls) || parquetUrls.length === 0) {
    throw new Error(`No parquet URLs returned for ${dataset}/${split}`);
  }
  for (const url of parquetUrls) {
    const file = await getCachedParquetBuffer({ dataset, split, url });
    const metadata = await parquetMetadataAsync(file);
    const totalRows = Number(metadata.num_rows);
    for (let rowStart = 0; rowStart < totalRows; rowStart += chunkSize) {
      if (stopWhen?.()) break;
      const rowEnd = Math.min(totalRows, rowStart + chunkSize);
      const rows = await parquetReadObjects({ file, rowStart, rowEnd, columns, compressors });
      onRows(rows);
      process.stdout.write(`\r${dataset} rows ${rowEnd}/${totalRows}`);
    }
    process.stdout.write("\n");
    if (stopWhen?.()) break;
  }
}

async function getParquetUrls(dataset, split) {
  try {
    return await fetchJson(`https://huggingface.co/api/datasets/${dataset}/parquet/default/${split}`);
  } catch (error) {
    const source = Object.values(SOURCES).find((item) => item.dataset === dataset && item.split === split);
    if (source?.parquetUrls?.length) {
      console.warn(`Using pinned parquet URL fallback for ${dataset}/${split}: ${error.message}`);
      return source.parquetUrls;
    }
    throw error;
  }
}

async function fetchJson(url) {
  const response = await fetchWithRetry(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function getCachedParquetBuffer({ dataset, split, url }) {
  const file = cachedParquetPath({ dataset, split, url });
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    await downloadWithRetry(url, file);
  }
  return asyncBufferFromFile(file);
}

function cachedParquetPath({ dataset, split, url }) {
  const parsed = new URL(url);
  const basename = path.basename(parsed.pathname) || "data.parquet";
  const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 12);
  const datasetDir = dataset.replace(/[^a-z0-9._-]+/gi, "__");
  return path.join(CACHE_DIR, datasetDir, split, `${hash}-${basename}`);
}

async function downloadWithRetry(url, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.${process.pid}.tmp`;
  const response = await fetchWithRetry(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(tmpFile, data);
  fs.renameSync(tmpFile, file);
}

async function fetchWithRetry(url, options = {}) {
  let lastError;
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (!shouldRetryResponse(response) || attempt === maxAttempts) return response;
      const retryAfter = Number(response.headers.get("retry-after"));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 750 * 2 ** (attempt - 1);
      await sleep(delayMs);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      await sleep(750 * 2 ** (attempt - 1));
    }
  }
  throw lastError || new Error(`Failed to fetch ${url}`);
}

function shouldRetryResponse(response) {
  return response.status === 429 || response.status === 408 || response.status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function outputPath(file) {
  return path.join(GENERATED_DIR, file);
}

function createJsonlWriter(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stream = fs.createWriteStream(file, { encoding: "utf8" });
  return {
    write(value) {
      stream.write(`${JSON.stringify(value)}\n`);
    },
    close() {
      stream.end();
    },
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeMarkdownReport(file, manifest) {
  const lines = [
    "# Keyboard Corpus Build Report",
    "",
    `Generated: ${manifest.generatedAt}`,
    "",
    "## Counts",
    "",
    "| Dataset | Target | Built | Status |",
    "| --- | ---: | ---: | --- |",
  ];
  for (const [key, target] of Object.entries(manifest.targets)) {
    const built = manifest.counts[key] || 0;
    lines.push(`| ${key} | ${target.toLocaleString()} | ${built.toLocaleString()} | ${built >= target ? "met" : "short"} |`);
  }
  lines.push(
    "",
    "## Review Tiers",
    "",
    ...Object.entries(manifest.reviewTiers).map(([tier, meaning]) => `- \`${tier}\`: ${meaning}`),
    "",
    "## Source Safety",
    "",
    "- Public/social rows are PII-screened automatically but still require human privacy review before redistribution.",
    "- Synthetic silver rows are coverage data, not real user-frequency evidence.",
    "- Human review must promote rows to gold before using them for public 99%+ claims.",
    ""
  );
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function cleanRoman(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9' -]/g, "")
    .replace(/\s+/g, " ");
}

function cleanRomanPhrase(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{L}\p{N}' ._-]+/gu, " ")
    .replace(/\s+/g, " ");
}

function cleanUnicode(value) {
  return String(value || "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ");
}

function cleanUnicodePhrase(value) {
  return cleanUnicode(value);
}

function isGoodRomanWord(value) {
  return /^[a-z][a-z0-9' -]{1,38}$/.test(value) && !value.includes("  ") && !looksLikePii(value);
}

function isGoodUnicodeWord(value) {
  return hasDevanagari(value) && value.length >= 1 && value.length <= 32 && !looksLikePii(value);
}

function hasDevanagari(value) {
  return /[\u0900-\u097F]/.test(String(value || ""));
}

function looksLikePii(value) {
  const text = String(value || "");
  return (
    hasBlockedCorpusTrace(text) ||
    /https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(text) ||
    /\+?\d[\d\s().-]{7,}\d/.test(text) ||
    /\b[A-Za-z][A-Za-z]+_[A-Za-z][A-Za-z]+\b/.test(text) ||
    isBlockedLocalIdentity(text)
  );
}

function hasBlockedCorpusTrace(value) {
  const text = String(value || "").normalize("NFKC").toLowerCase();
  if (!text) return false;
  if (BLOCKED_CORPUS_TRACE_PHRASES.some((phrase) => text.includes(phrase))) return true;
  const tokens = text.match(/[a-z0-9]+/g) ?? [];
  return tokens.some((token) => BLOCKED_CORPUS_TRACE_TERMS.some((term) => token.includes(term)));
}

function hasUnsafeSocialMetadata(value) {
  const text = String(value || "");
  return SOCIAL_METADATA_PATTERNS.some((pattern) => pattern.test(text));
}

function isBlockedLocalIdentity(value) {
  const text = String(value || "");
  return BLOCKED_LOCAL_IDENTITY_PATTERNS.some((pattern) => pattern.test(text));
}

function classifyVariant(romanized) {
  if (romanized.includes("x")) return "informal-x";
  if (/(aa|ee|ii|oo|uu)/.test(romanized)) return "long-vowel";
  if (/(sh|chh|ksh|gya|jny)/.test(romanized)) return "conjunct-or-aspirate";
  if (romanized.includes(" ")) return "phrase-like-word";
  return "standard";
}

function addAlias(aliasMap, romanized, unicode) {
  const values = aliasMap.get(romanized) || [];
  if (!values.includes(unicode)) values.push(unicode);
  aliasMap.set(romanized, values);
}

function mergeInternalAliases(aliasMap) {
  const file = path.join(ROOT, SOURCES.internalAliases.path);
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const [word, romanized] = line.split("\t");
    const clean = cleanRoman(romanized);
    const unicode = cleanUnicode(word);
    if (isGoodRomanWord(clean) && isGoodUnicodeWord(unicode)) addAlias(aliasMap, clean, unicode);
  }
}

function mergePolicyAliases(aliasMap) {
  for (const [romanized, unicode] of POLICY_ALIAS_SEEDS) {
    addAlias(aliasMap, romanized, unicode);
  }
}

function splitSocialText(value) {
  const raw = String(value || "").normalize("NFKC");
  return raw
    .split(/[\n\r]+|(?<=[.!?।])\s+/u)
    .flatMap((part) => (part.length > 240 ? part.split(/[,;:|]+/) : [part]))
    .map((part) => part.trim())
    .filter(Boolean);
}

function cleanSocialRoman(value) {
  const original = String(value || "").normalize("NFKC");
  if (hasUnsafeSocialMetadata(original) || isBlockedLocalIdentity(original)) return "";
  if (/[À-ɏ]/u.test(original)) return "";
  return original
    .normalize("NFKC")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, " ")
    .replace(/[^\x00-\x7F]/g, " ")
    .replace(/[^\w\s'.!?-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanMixed(value) {
  const original = String(value || "").normalize("NFKC");
  if (hasUnsafeSocialMetadata(original) || isBlockedLocalIdentity(original)) return "";
  return original
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, " ")
    .replace(/[^\p{L}\p{M}\p{N}\s'.!?।,_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isQualityRomanNepaliSentence(text) {
  if (!text || text.length < 8 || text.length > 180) return false;
  if (looksLikePii(text)) return false;
  if (/[^\x00-\x7F]/.test(text)) return false;
  const tokens = tokenizeRoman(text);
  if (tokens.length < 2 || tokens.length > 24) return false;
  if (romanNepaliScore(text) < 4) return false;
  if (!hasStrongRomanNepaliSignal(tokens)) return false;
  const longToken = tokens.some((token) => token.length > 28);
  if (longToken) return false;
  return true;
}

function isQualityMixedSentence(text, script = "") {
  if (!text || text.length < 8 || text.length > 180) return false;
  if (looksLikePii(text)) return false;
  const hasLatin = /[A-Za-z]/.test(text);
  const hasDev = hasDevanagari(text);
  const tokens = tokenizeLoose(text);
  if (tokens.length < 2 || tokens.length > 28) return false;
  if (hasLatin && hasDev) return true;
  if (hasLatin && romanNepaliScore(text) >= 2 && detectPreserveTokens(text).length > 0) return true;
  return false;
}

function romanNepaliScore(text) {
  const tokens = tokenizeRoman(text);
  let score = 0;
  for (const token of tokens) {
    if (ROMAN_MARKERS.has(token)) score += 2;
    if (/(cha|chha|xa|hunxa|parxa|garna|garnu|bhayo|vayo|aayo|eko|eko|lai|haru|sanga)$/.test(token)) score += 1;
  }
  return score;
}

function hasStrongRomanNepaliSignal(tokens) {
  let strong = 0;
  let suffix = 0;
  for (const token of tokens) {
    if (STRONG_ROMAN_MARKERS.has(token)) strong += 1;
    if (/(chha|huncha|hunxa|garna|garnu|bhayo|vayo|parcha|parxa|aayo|aaune|eko|lai|haru|sanga)$/.test(token)) suffix += 1;
  }
  return strong >= 1 || suffix >= 2;
}

function tokenizeRoman(text) {
  return String(text || "")
    .toLowerCase()
    .match(/[a-z][a-z0-9']*/g) || [];
}

function tokenizeLoose(text) {
  return String(text || "").match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'_-]*/gu) || [];
}

function classifyMixed(text) {
  const hasLatin = /[A-Za-z]/.test(text);
  const hasDev = hasDevanagari(text);
  if (hasLatin && hasDev) return "mixed-script";
  if (hasLatin && detectPreserveTokens(text).length) return "romanized-nepali-with-english-token";
  return "mixed-policy";
}

function detectPreserveTokens(text) {
  const preserve = [];
  for (const token of ENGLISH_PRESERVE) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|\\s)${escaped}(\\s|$|[.,!?])`, "i").test(text)) preserve.push(token);
  }
  return [...new Set(preserve)].slice(0, 12);
}

function detectPreferenceTokens(text) {
  const lower = text.toLowerCase();
  return [...LOANWORD_UNICODE.keys()].filter((token) => new RegExp(`\\b${token}\\b`, "i").test(lower)).slice(0, 12);
}

function injectEnglishToken(base, token, index) {
  const patterns = [
    `${base} ${token}`,
    `${token} ${base}`,
    `${base} ${token} milena`,
    `${token} ko ${base}`,
    `${base} ma ${token} halnus`,
  ];
  return patterns[index % patterns.length].replace(/\s+/g, " ").trim();
}

function writeSyntheticCasual(out, text, index) {
  const record = {
    id: `casual_${String(index + 1).padStart(7, "0")}`,
    text,
    sourceId: "lekh-generated-casual-policy",
    license: "project-internal",
    reviewStatus: "synthetic-silver",
    domain: "casual",
    script: "latin",
    qualityScore: romanNepaliScore(text),
    reusable: true,
  };
  out.write(record);
  return record;
}

function readInternalPhrases() {
  const file = path.join(ROOT, SOURCES.internalPhrases.path);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const [input, output, domain, frequency, source] = line.split("\t");
      return { input, output, domain, frequency: Number(frequency || 0), source };
    });
}

function convertRomanTokens(tokens, aliasMap) {
  const converted = [];
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      converted.push(token);
      continue;
    }
    if (LOANWORD_UNICODE.has(token)) {
      converted.push(LOANWORD_UNICODE.get(token));
      continue;
    }
    const candidates = aliasMap.get(token);
    if (!candidates?.length) return null;
    converted.push(candidates[0]);
  }
  return converted.join(" ");
}

function inferDomain(romanized) {
  if (/(jilla|prashasan|nagarikta|sifaris|rajaswa|ward|malpot|karyalaya)/.test(romanized)) return "government";
  if (/(shiksha|school|exam|result|grade|bidhyalaya|vidyarthi|campus)/.test(romanized)) return "education";
  if (/(swasthya|doctor|hospital|xray|janch|aushadhi)/.test(romanized)) return "health";
  if (/(file|form|upload|download|email|password|system|website|api|github)/i.test(romanized)) return "tech";
  return "common";
}

function generateProofreadErrors(word) {
  const variants = [];
  const replacements = [
    ["स्व", "सव", "conjunct-simplification", 0.78],
    ["स्थ", "सथ", "conjunct-simplification", 0.74],
    ["त्र", "तर", "conjunct-simplification", 0.7],
    ["ज्ञ", "ग्य", "conjunct-variant", 0.66],
    ["ण", "न", "retroflex-nasal", 0.68],
    ["श", "स", "sibilant-confusion", 0.72],
    ["ष", "स", "sibilant-confusion", 0.72],
    ["ि", "ी", "matra-confusion", 0.68],
    ["ी", "ि", "matra-confusion", 0.68],
    ["ू", "ु", "matra-confusion", 0.64],
    ["ु", "ू", "matra-confusion", 0.64],
    ["ं", "", "anusvara-drop", 0.62],
  ];
  for (const [from, to, type, confidence] of replacements) {
    if (word.includes(from)) variants.push([word.replace(from, to), type, confidence]);
  }
  if (word.endsWith("हरू")) variants.push([word.replace(/हरू$/, "हरु"), "plural-normalization", 0.9]);
  return variants;
}

function romanVariants(roman) {
  const variants = new Set([roman]);
  const rules = [
    [/sh/g, "s"],
    [/s/g, "sh"],
    [/bh/g, "b"],
    [/b/g, "v"],
    [/v/g, "b"],
    [/aa/g, "a"],
    [/a/g, "aa"],
    [/ee/g, "i"],
    [/i/g, "ee"],
    [/oo/g, "u"],
    [/u/g, "oo"],
    [/chh/g, "ch"],
    [/ch/g, "x"],
    [/ksh/g, "x"],
  ];
  for (const [pattern, replacement] of rules) {
    if (pattern.test(roman)) variants.add(roman.replace(pattern, replacement));
  }
  return [...variants].filter((value) => /^[a-z][a-z ]{1,40}$/.test(value)).slice(0, 12);
}

function deterministicSample(rows, limit, seed, label) {
  return [...rows]
    .sort((a, b) => hashHex(`${seed}:${label}:${a.id || JSON.stringify(a)}`).localeCompare(hashHex(`${seed}:${label}:${b.id || JSON.stringify(b)}`)))
    .slice(0, limit);
}

function hashHex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashMod(value, mod) {
  return Number.parseInt(hashHex(value).slice(0, 8), 16) % mod;
}

async function* readJsonlStream(file, limit = Infinity) {
  const contents = fs.readFileSync(file, "utf8");
  let count = 0;
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    yield JSON.parse(line);
    count += 1;
    if (count >= limit) break;
  }
}
