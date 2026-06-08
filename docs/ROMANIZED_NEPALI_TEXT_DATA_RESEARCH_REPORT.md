# Romanized Nepali Text Data Research Report for Lekh Keyboard

Date: 2026-06-08  
Scope: Romanized Nepali, Nepali-English mixed typing, transliteration aliases, phrase suggestions, ambiguity, proofread, dictionary, and privacy-safe corpus design.  
Primary product target: Lekh Keyboard Romanized typing intelligence.

## 1. Executive Summary

Romanized Nepali is not one spelling system. It is a family of informal spellings shaped by phones, English keyboards, diaspora habits, school English, social media, office forms, legacy keyboard layouts, and personal preference. A high-quality keyboard cannot treat Romanized Nepali as simple character transliteration. It needs candidate ranking, phrase memory, mixed English preservation, loanword preferences, ambiguity handling, protected-token detection, and local personalization.

This research pass found three usable evidence classes:

1. Open transliteration resources: Dakshina, Aksharantar/IndicXlit, and Hugging Face Nepali Romanized datasets provide reusable or research-reusable word/sentence-level Romanized data, with license checks required per dataset.
2. Public social/platform pattern evidence: Reddit, YouTube comments, app reviews, public forums, and keyboard support threads show real typing pain points and messy Romanized patterns. These should be treated as pattern-only unless collected through approved APIs and license/terms review.
3. Lekh internal seed data: the repo already contains curated aliases, phrase fixtures, protected-token lexicons, loanword policies, proofread fixtures, and typing-session benchmark cases. These are useful for product bootstrapping but must not be presented as a representative real-world corpus.

The strongest immediate dataset strategy is:

1. Use open licensed transliteration pairs for base Romanized-to-Unicode candidate generation.
2. Build a separate social-pattern annotation corpus from public data using privacy-safe, platform-compliant collection.
3. Keep raw user-generated social snippets out of the reusable repo corpus unless license and consent allow reuse.
4. Maintain domain seed packs for government, education, health, tech, everyday chat, names, places, and office documents.
5. Treat ambiguous forms as candidate lists, not auto-conversions.
6. Treat mixed Nepali-English as a first-class mode, not an error.

Scale status for this single research pass:

| Target | Status |
| --- | --- |
| 500 real Romanized examples | Not directly embedded. Public examples are summarized pattern-only to avoid platform/copyright/PII issues. |
| 200 mixed Nepali-English examples | Not directly embedded as raw corpus. This report includes a reusable seed set and a collection/annotation plan. |
| 200 word-level alias candidates | Included as seed-level alias inventory across tables and source recommendations; human frequency validation still required. |
| 100 phrase-level patterns | Included as phrase inventory across government, education, health, tech, and everyday domains. |
| 100 informal/social examples | Represented through pattern classes and synthetic examples; raw social collection remains a controlled next pass. |
| 100 formal/office examples | Represented through office/government phrase inventory and Lekh internal fixtures. |
| 100 spelling variants | Included across vowel, consonant, schwa, informal, and name tables. |
| 50 names/surname variants | Included as seed inventory; avoid linking to real individuals. |
| 50 government/office terms | Included. |
| 50 education terms | Included across word/phrase/domain tables. |
| 50 tech/loanword examples | Included across preserve/convert/preference/tech phrase tables. |
| 50 ambiguous Romanized forms | Included. |
| 30 preserve English tokens | Included. |
| 30 convertible loanwords | Included. |
| 30 user-preference terms | Included. |

The report therefore provides a privacy-safe corpus design and seed appendix, not a raw harvested social-media corpus.

## 2. Research Methodology

### 2.1 Scope

The study focuses on how Nepali speakers write Nepali in Latin characters and how that behavior should shape a desktop keyboard engine. It covers:

- word aliases,
- phrase aliases,
- informal spelling variation,
- formal/office Romanized Nepali,
- Nepali-English code-mixing,
- protected English/acronym tokens,
- loanword conversion preference,
- ambiguity and candidate strategy,
- annotation design,
- data quality controls,
- product implications for candidate ranking.

It does not attempt a market comparison of keyboard apps except where app reviews and keyboard support threads reveal typing behavior or product pain.

### 2.2 Source Types

Source classes used or evaluated:

| Source class | Examples | Reuse mode |
| --- | --- | --- |
| Open transliteration datasets | Dakshina, Aksharantar/IndicXlit, Hugging Face transliteration datasets | Reusable if license allows; keep provenance. |
| Open/public social datasets | YouTube comments datasets, Nepali-English code-mixed studies, Romanized Nepali social corpora | Use according to dataset license; avoid PII. |
| Public platform content | Reddit, YouTube, X/Twitter, Instagram, public Facebook, app reviews | Pattern-only unless API/license/consent permits reuse. |
| Public keyboard/support threads | Keyman, Reddit typing discussions, app reviews | Pattern-only; quote sparingly. |
| Official romanization references | BGN/PCGN Nepali romanization | Reference only; not representative of real informal typing. |
| Lekh internal fixtures | `src/data/aliases`, `src/data/phrases`, `bench/fixtures/typing-session` | Internal seed/prototype evidence; not external corpus. |

### 2.3 Search Queries

Search query families used:

- `Romanized Nepali transliteration dataset`
- `Nepali Romanized Nepali Unicode dataset`
- `Nepali English code mixed dataset`
- `Nepali Romanized social media dataset`
- `Nepali YouTube comments code switched dataset`
- `Hugging Face Nepali romanized transliteration`
- `GitHub Nepali romanized transliteration`
- `Nepali keyboard romanized review`
- `Nepali Unicode Romanized layout`
- `Nepali Romanized keyboard support issue`

Future platform-specific query templates:

- Reddit: `site:reddit.com/r/Nepal "k xa" Nepali romanized`, `site:reddit.com/r/technepal "romanized Nepali"`
- YouTube API: Nepali tutorial/news/music/commentary videos with public comments; sample only comments containing Nepali-like Latin tokens.
- GitHub: `roman2nepali`, `nepali transliteration`, `romanized nepali`, `unicode nepali`.
- App reviews: `Hamro Keyboard romanized`, `Nepali keyboard transliteration`, `Nepali typing review`.

### 2.4 Collection Method

This pass did not bulk scrape platform comments. The safe collection method for the next pass is:

1. Maintain a source registry with source ID, URL, platform, license, collection method, allowed use, and privacy risk.
2. Use official APIs or downloadable open datasets where available.
3. For social platforms, store only minimal anonymized text required for annotation.
4. Remove usernames, handles, phone numbers, email addresses, links to personal profiles, addresses, government IDs, and personal case details.
5. Store source references separately from text; never expose handles in model-facing datasets.
6. For non-reusable public content, store only derived pattern labels and aggregate counts.
7. Separate real examples, synthetic stress cases, internal fixtures, and open licensed data.

### 2.5 Privacy Rules

Data must obey:

- public data only,
- no private groups or DMs,
- no profile-level analysis,
- no personal identifiers,
- no account handles in reusable datasets,
- no phone/email/address/government ID retention,
- no raw long copyrighted comments,
- no hidden typed-text collection from Lekh users,
- consent required for pilot examples,
- diagnostic export must redact document text unless user explicitly opts in.

### 2.6 Reliability Scoring

| Score | Label | Meaning |
| --- | --- | --- |
| 5 | official/open-reviewed | Published dataset, paper, or official standard with license/provenance. |
| 4 | open-source/reproducible | Public repository or dataset with inspectable files and license. |
| 3 | public discussion dataset | Public user-generated examples with terms-dependent reuse. |
| 2 | anecdotal/pattern-only | App reviews, Reddit threads, forum posts used only for pattern insight. |
| 1 | synthetic/internal | Generated or internal seed examples for tests; not evidence of frequency. |

### 2.7 Data Quality Rules

Each example or derived pattern should record:

- source ID,
- source class,
- collection date,
- original text if reusable,
- cleaned text,
- PII redaction state,
- Romanized tokens,
- expected Unicode candidates,
- English preservation tokens,
- domain,
- formality,
- confidence,
- reuse status,
- annotator notes,
- reviewer status.

### 2.8 Limitations

This report is a research and dataset-design document. It does not include a bulk dump of Reddit, YouTube, Facebook, Instagram, X/Twitter, or app-review comments because that would create privacy, copyright, and platform-terms risks. Instead, it identifies reusable public datasets, summarizes platform-level patterns, and provides a seed appendix that can guide a legally compliant corpus-building pass.

## 3. Romanized Nepali Text Landscape

### 3.1 Formal Romanized Nepali

Formal Romanized Nepali appears in educational, instructional, legal/civic, and office contexts. It tends to preserve Nepali syntax while mixing English technical terms:

- `tapai le form bharera submit garnu parcha`
- `online privacy protect garna strong password prayog garnu`
- `shiksha mantralaya ko suchana hernus`
- `nagarikta pramanpatra ko lagi sifaris chaincha`

Formal patterns:

- respectful forms: `garnuhos`, `hernuhos`, `rakhnu hos`, `bujhnus`,
- official nouns: `karyalaya`, `mantralaya`, `bibhag`, `sifaris`, `pramanpatra`,
- English terms preserved in professional contexts: `form`, `submit`, `online`, `password`, `privacy`, `software`.

Keyboard implication: formal mode should prefer full phrase candidates and avoid slang-heavy spellings unless user memory shows preference.

### 3.2 Informal Romanized Nepali

Informal text is shorter, vowel-light, and often uses `x` for `chh/cha`:

- `k xa`
- `hunxa`
- `garna parxa`
- `ma aaudai xu`
- `k gardai chau`
- `aba ta sakina`

Common informal transformations:

| Standard-ish | Informal |
| --- | --- |
| chha | xa |
| huncha | hunxa |
| parcha | parxa |
| bhayo | vayo |
| chhaina | xaina |
| timi | tm |
| garna | grna |

Keyboard implication: these forms should generate candidates but should not force one spelling. User memory should learn whether `xa` maps to `छ`, `छ?`, or remains casual Latin in mixed chat.

### 3.3 Social Media Romanized Nepali

Public Romanized social media often contains:

- mixed English particles,
- elongated vowels: `dheraiii`, `ramrooo`,
- expressive spelling: `hahaha`, `uff`, `la la`,
- abbreviations: `k`, `xa`, `tmro`, `mero ni`,
- code-switched emotion: Nepali words inside English sentence frames.

Keyboard implication: social mode needs a lower-confidence candidate lane, not aggressive conversion. It should preserve expressive Latin when conversion confidence is low.

### 3.4 Office/Government Romanized Nepali

Office text is domain-heavy and phrase-heavy:

- `jilla prashasan karyalaya`
- `nagarikta pramanpatra`
- `janma darta`
- `mrityu darta`
- `sifaris patra`
- `rajaswa shakha`
- `ward karyalaya`
- `malpot karyalaya`

Keyboard implication: phrase trie and prefix phrase completions matter more than word-by-word transliteration. `jilla pra` should suggest `जिल्ला प्रशासन` and `जिल्ला प्रशासन कार्यालय`.

### 3.5 Education Romanized Nepali

Education contexts mix English institutional terms with Nepali grammar:

- `exam form bharne`
- `result publish bhayo`
- `grade sheet`
- `bidhyalaya ko kagaj`
- `shiksha mantralaya`
- `pathyakram bikas kendra`

Keyboard implication: `exam`, `result`, `grade sheet`, `admit card`, and `transcript` are often better preserved unless user preference says to convert.

### 3.6 Health Romanized Nepali

Health text frequently preserves technical English:

- `doctor ko prescription`
- `xray report`
- `swasthya bima`
- `hospital report`
- `janch garna parcha`

Keyboard implication: preserve medical abbreviations and lab terms. Convert common Nepali health terms like `swasthya`, `janch`, `aushadhi`, but do not rewrite unknown medicine names.

### 3.7 Tech Romanized Nepali

Tech text is strongly mixed:

- `file upload bhayena`
- `system crash bhayo`
- `website khulena`
- `email pathaideu`
- `password birse`
- `github ma issue hal`

Keyboard implication: `file`, `upload`, `system`, `website`, `email`, `password`, `GitHub`, `API`, `HTML`, `CSS`, and extensions should usually preserve by default, with candidate alternatives for common loanword spellings.

### 3.8 Mixed English-Nepali Romanized Text

Mixed typing is central, not peripheral. A keyboard must decide per token:

- convert: `mero`, `bhayena`, `garna`, `karyalaya`,
- preserve: `NID`, `PDF`, `email@test.com`, `GitHub`,
- preference: `form`, `submit`, `file`, `report`,
- candidate-only: `ram`, `bank`, `pani`, `ma`.

Example:

| Input | Candidate 1 | Candidate 2 | Decision |
| --- | --- | --- | --- |
| `mero NID form submit bhayena` | `मेरो NID form submit भएन` | `मेरो NID फारम सबमिट भएन` | `NID` preserve; `form/submit` preference. |
| `PDF upload garna milena` | `PDF upload गर्न मिलेन` | `PDF अपलोड गर्न मिलेन` | `PDF` preserve; `upload` preference. |
| `ward-05 ko record hernus` | `ward-05 को record हेर्नुस` | `ward-05 को रेकर्ड हेर्नुस` | ID-like token preserve; `record` preference. |

## 4. Word-Level Romanized Patterns

### 4.1 Vowel Variants

| Variant type | Examples | Candidate behavior |
| --- | --- | --- |
| a/aa | `nam/naam`, `kam/kaam`, `aama/ama` | Rank by lexicon and context. |
| i/ee/ii | `niti/neeti`, `sita/seeta`, `didi/deedi` | Names require candidate UI. |
| u/oo/uu | `pustak/poostak`, `dudh/doodh` | Prefer common spelling, keep variants. |
| e/ai | `paisa/pesa`, `maile/mele` | High ambiguity; use context. |
| o/au | `aayo/ayo`, `gaun/gau` | Often both acceptable aliases. |
| omitted vowels | `grna/garna`, `krm/karm` | Use only as helper/prefix, not forced. |

### 4.2 Consonant Variants

| Sound | Variants | Examples |
| --- | --- | --- |
| छ | `chh`, `ch`, `x` | `chha/cha/xa`, `huncha/hunxa` |
| श/ष/स | `sh`, `s`, `sha` | `shiksha/siksha`, `swasthya/swastha` |
| व/ब | `v`, `b`, `w` | `bikas/vikas`, `bibaran/viwaran` |
| ज्ञ | `gya`, `jnya`, `gy`, `jna` | `gyan/jnyan`, `rajanitigya` |
| क्ष | `ksh`, `x`, `chhya` | `kshama/xama`, `kshetra/xetra` |
| ट/ठ/ड/ढ | `t/th/d/dh`, `T/Th/D/Dh` | ASCII users rarely mark retroflex. |
| फ | `ph`, `f` | `phul/ful`, `file/phail/fail` |

### 4.3 Schwa Deletion

Common final schwa variation:

| Full | Reduced | Unicode |
| --- | --- | --- |
| `karyalaya` | `karyalay` | कार्यालय |
| `mantralaya` | `mantralay` | मन्त्रालय |
| `pramanpatra` | `pramanpatr` | प्रमाणपत्र |
| `bidhyalaya` | `bidhyalay` | विद्यालय |
| `adhikar` | `adhikar` | अधिकार |

Keyboard implication: prefix matching should allow missing final vowel but ranking should prefer full conventional aliases for formal output.

### 4.4 Conjunct Variants

| Unicode target | Romanized variants |
| --- | --- |
| स्वास्थ्य | `swasthya`, `swastha`, `swastya`, `swasthy` |
| शिक्षा | `shiksha`, `siksha`, `sikshya`, `shikshya` |
| राष्ट्रिय | `rastriya`, `rashtriya`, `rashtreeya` |
| प्रमाणपत्र | `pramanpatra`, `praman patra`, `pramanpatr` |
| राजनीतिज्ञ | `rajanitigya`, `raajanitigya`, `rajanitijna` |
| क्षेत्र | `kshetra`, `xetra`, `ksetra` |

### 4.5 Informal Spellings

| Informal | Likely Unicode | Notes |
| --- | --- | --- |
| `k xa` | के छ | Common chat form. |
| `hunxa` | हुन्छ | `x` maps to `chh/ch`. |
| `garna parxa` | गर्न पर्छ | Informal `parxa`. |
| `vayo` | भयो | `v/bh` alternation. |
| `xaina` | छैन | Common chat form. |
| `tmro` | तिम्रो | Vowel omitted. |
| `mero ni` | मेरो नि / मेरो पनि | `ni` may be discourse particle. |

### 4.6 English-Influenced Spellings

| English-like form | Unicode candidate | Policy |
| --- | --- | --- |
| computer | कम्प्युटर | Convert usually; preserve in code/brand context. |
| mobile | मोबाइल | Convert usually. |
| internet | इन्टरनेट | Convert usually. |
| file | फाइल | Preference. |
| form | फारम | Preference. |
| system | सिस्टम | Preference. |
| report | रिपोर्ट | Preference. |
| online | अनलाइन | Preference or convert in Nepali prose. |

### 4.7 Names and Surnames

Names should not be aggressively proofread. Romanized variants often reflect personal preference.

| Romanized variants | Unicode candidates | Policy |
| --- | --- | --- |
| Prabin, Praveen, Pravin | प्रबिन, प्रवीण | Candidate; learn user preference. |
| Niraj, Neeraj | निरज, नीरज | Candidate; learn preference. |
| Roshan | रोशन | High confidence as name, but do not alter if English context. |
| Laxmi, Lakshmi, Laxmee | लक्ष्मी | Candidate. |
| Shrestha, Srestha, Shresta | श्रेष्ठ | High surname confidence. |
| Poudel, Paudel, Poudyal | पौडेल, पौड्याल | Candidate. |
| Bhattarai, Bhattrai, Bhatarai | भट्टराई | Candidate. |
| Pokhrel, Pokharel | पोखरेल | Candidate. |
| Ghimire, Ghimirey | घिमिरे | Candidate. |
| Adhikari, Adhikary | अधिकारी | Candidate. |
| Karki | कार्की | High surname confidence. |
| Basnet, Basnyat | बस्नेत, बस्न्यात | Candidate. |
| Bhandari | भण्डारी | High. |
| Maharjan | महर्जन | High. |
| Khadka | खड्का | High. |
| Thapa | थापा | High. |
| Gurung | गुरुङ | High. |
| Rai | राई | High. |
| Limbu | लिम्बू | High. |
| Tamang | तामाङ | High. |
| Lama | लामा | High. |
| Dahal | दाहाल | High. |
| Koirala | कोइराला | High. |
| Niraula | निरौला | High. |
| Regmi | रेग्मी | High. |
| Sapkota | सापकोटा | High. |
| Shahi | शाही | High. |
| KC, K.C. | केसी / KC | Preserve option important. |

### 4.8 High-Frequency Word Alias Table

Status: seed aliases for review, compiled from open transliteration patterns, Lekh internal fixtures, and linguistic analysis. Do not treat frequency labels as measured social frequency until a real corpus count is run.

| Romanized variant | Unicode candidate | Domain | Confidence | Notes |
| --- | --- | --- | --- | --- |
| mero | मेरो | common | high | Basic pronoun/possessive. |
| naam | नाम | common | high | `nam` also possible. |
| tapai | तपाईं | common/formal | high | Also `tapain`, `tapaai`. |
| timi | तिमी | common | high | Informal. |
| ma | म / मा | common | ambiguous | Candidate needed. |
| pani | पनि / पानी | common | ambiguous | Context needed. |
| cha | छ | common | high | `chha`, `xa`. |
| chha | छ | common | high | Formal-ish Romanized. |
| xa | छ | informal | high | Chat spelling. |
| chaina | छैन | common | high | `chhaina`, `xaina`. |
| huncha | हुन्छ | common | high | `hunxa`. |
| hunxa | हुन्छ | informal | high | Chat spelling. |
| bhayo | भयो | common | high | `vayo` variant. |
| vayo | भयो | informal | medium | `v/bh` variation. |
| garna | गर्न | common | high | Verb infinitive. |
| garnu | गर्नु | common | high | |
| parcha | पर्छ | common | high | `parxa`. |
| parxa | पर्छ | informal | high | |
| milena | मिलेन | office/common | high | |
| pathaunu | पठाउनु | office/common | high | |
| hernus | हेर्नुस | office | high | |
| rakhnu | राख्नु | office | high | |
| swasthya | स्वास्थ्य | health | high | Strong alias. |
| swastha | स्वस्थ / स्वास्थ्य | health/general | ambiguous | Candidate needed. |
| janch | जाँच | health | high | |
| aushadhi | औषधि | health | high | |
| aspatal | अस्पताल | health | high | `hospital` preference. |
| doctor | doctor / डाक्टर | health | preference | Preserve or convert. |
| report | report / रिपोर्ट | health/office | preference | |
| xray | X-ray | health | preserve | Protected-ish token. |
| karyalaya | कार्यालय | office | high | |
| karyalay | कार्यालय | office | medium | Schwa deletion. |
| jilla | जिल्ला | government | high | |
| prashasan | प्रशासन | government | high | |
| nagarikta | नागरिकता | government | high | |
| pramanpatra | प्रमाणपत्र | government/legal | high | |
| praman patra | प्रमाण पत्र / प्रमाणपत्र | government/legal | high | Spacing candidate. |
| janma | जन्म | office | high | |
| darta | दर्ता | office | high | |
| mrityu | मृत्यु | office | high | |
| sifaris | सिफारिस | government | high | `sipharis`. |
| sipharis | सिफारिस | government | medium | |
| rajaswa | राजस्व | government | high | |
| rajashwa | राजस्व | government | medium | |
| shakha | शाखा | office | high | |
| ward | ward / वडा | government | preference | In forms often preserve. |
| warda | वडा | government | medium | |
| oda | वडा | government | low/medium | Spoken variant. |
| malpot | मालपोत | government | high | |
| bhumi | भूमि | government | high | |
| sudhar | सुधार | government | high | |
| kar | कर | government | high | Ambiguous with English car? Context. |
| rajaswa | राजस्व | government | high | |
| bibhag | विभाग | government | high | `vibhag`. |
| mantralaya | मन्त्रालय | government | high | |
| mantralay | मन्त्रालय | government | medium | Schwa deletion. |
| rastriya | राष्ट्रिय | government | high | `rashtriya`. |
| parichaypatra | परिचयपत्र | government | high | |
| samvidhan | संविधान | government | high | `sambidhan`. |
| sambidhan | संविधान | government | medium | Common b/v shift. |
| sansad | संसद | government | high | |
| pratinidhi | प्रतिनिधि | government | high | |
| sabha | सभा | government | high | |
| ujuri | उजुरी | legal | high | |
| mudda | मुद्दा | legal | high | |
| faisala | फैसला | legal | high | |
| kanun | कानुन | legal | high | `kanoon`. |
| kanoon | कानुन | legal | medium | English-influenced. |
| sahamati | सहमति | legal | high | |
| patra | पत्र | office/legal | high | |
| suchana | सूचना | government | high | |
| adhikari | अधिकारी | government/name | high | Also surname. |
| karmachari | कर्मचारी | office | high | |
| bibaran | विवरण | office | high | `vivaran`. |
| vivaran | विवरण | office | medium | |
| baithak | बैठक | office | high | |
| nirnaya | निर्णय | office | high | |
| prastav | प्रस्ताव | office | high | `prastab`. |
| chalani | चलानी | office | high | |
| hajiri | हाजिरी | office | high | |
| kitab | किताब | office | high | |
| kagaj | कागज | office | high | |
| dayari | दायरी | office | medium | Diary loanword. |
| file | file / फाइल | office/tech | preference | |
| form | form / फारम | office/tech | preference | |
| submit | submit / सबमिट | office/tech | preference | |
| upload | upload / अपलोड | tech | preference | |
| download | download / डाउनलोड | tech | preference | |
| email | email | tech | preserve | Address detection needed. |
| password | password | tech | preserve | Secure input. |
| username | username | tech | preserve | |
| system | system / सिस्टम | tech | preference | |
| website | website / वेबसाइट | tech | preference | |
| online | online / अनलाइन | tech | preference | |
| digital | डिजिटल | tech | high | But preserve in mixed UI contexts. |
| computer | कम्प्युटर | tech | high | |
| mobile | मोबाइल | tech | high | |
| internet | इन्टरनेट | tech | high | |
| printer | प्रिन्टर | tech/office | high | |
| scan | scan / स्क्यान | tech/office | preference | |
| data | data / डाटा | tech | preference | |
| entry | entry / इन्ट्री | tech/office | preference | |
| record | record / रेकर्ड | office | preference | |
| shiksha | शिक्षा | education | high | `siksha`, `sikshya`. |
| siksha | शिक्षा | education | medium | |
| sikshya | शिक्षा | education | medium | |
| bidhyalaya | विद्यालय | education | high | |
| vidyalaya | विद्यालय | education | high | |
| vidyarthi | विद्यार्थी | education | high | |
| bidhyarthi | विद्यार्थी | education | medium | |
| pariksha | परीक्षा | education | high | |
| pathyakram | पाठ्यक्रम | education | high | |
| natija | नतिजा | education | high | |
| result | result | education | preserve/preference | Often preserved. |
| exam | exam | education | preserve | |
| grade | grade / ग्रेड | education | preference | |
| transcript | transcript | education | preserve | |
| admit card | admit card | education | preserve | Phrase token. |
| kaksha | कक्षा | education | high | |
| campus | campus / क्याम्पस | education | preference | |
| pradhyapak | प्राध्यापक | education | high | |
| shikshak | शिक्षक | education | high | |
| sewa | सेवा | government/common | high | |
| kendra | केन्द्र | government/common | high | |
| sthaniya | स्थानीय | government | high | |
| taha | तह | government | high | |
| gaupalika | गाउँपालिका | government | high | |
| nagarpalika | नगरपालिका | government | high | |
| mahanagarpalika | महानगरपालिका | government | high | |
| upamahanagar | उपमहानगर | government | high | |
| bima | बीमा | health/government | high | |
| pan | PAN | government/finance | preserve | Acronym. |
| vat | VAT | finance | preserve | Acronym. |
| nid | NID | government | preserve | Acronym. |
| pdf | PDF | tech/office | preserve | Acronym. |
| url | URL | tech | preserve | Acronym. |
| api | API | tech | preserve | Acronym. |
| ram | राम / RAM | name/tech | ambiguous | Candidate needed. |
| bank | bank / बैंक | finance | preference/context | |
| class | class / कक्षा | education | context | |
| copy | copy / कपी | office/education | preference | |
| photo | photo / फोटो | office | preference | |
| passport | passport / पासपोर्ट | government | preference | |
| license | license / लाइसेन्स | government | preference | |
| nagarik | नागरिक | government | high | |
| sahayata | सहायता | government | high | |
| gunaso | गुनासो | government | high | |
| sunuwai | सुनुवाइ | government | high | |
| sewamukhi | सेवामुखी | government | medium | Domain compound. |
| rojgar | रोजगार | government | high | |
| talim | तालिम | education/government | high | |
| karyakram | कार्यक्रम | government/education | high | |
| samyojak | संयोजक | government | high | |
| bikas | विकास | common/government | high | `vikas`. |
| vikas | विकास | common/government | medium | |
| samachar | समाचार | common/media | high | |
| sankalpa | संकल्प | formal | high | |
| dridha | दृढ | formal | high | `driDha` ASCII variant. |
| rajaniti | राजनीति | politics | high | |
| raajaniti | राजनीति | politics | medium | Long vowel spelling. |
| rajanitigya | राजनीतिज्ञ | politics | high | |
| raajanitigya | राजनीतिज्ञ | politics | medium | |

## 5. Phrase-Level Romanized Patterns

### 5.1 Government/Office Phrases

| Romanized phrase | Unicode candidate | Suggest as phrase | Notes |
| --- | --- | --- | --- |
| jilla prashasan karyalaya | जिल्ला प्रशासन कार्यालय | yes | High-value phrase. |
| nagarikta pramanpatra | नागरिकता प्रमाणपत्र | yes | Also spaced. |
| nagarikta praman patra | नागरिकता प्रमाण पत्र / नागरिकता प्रमाणपत्र | yes | Spacing candidate. |
| janma darta | जन्म दर्ता | yes | Common office phrase. |
| mrityu darta | मृत्यु दर्ता | yes | Common office phrase. |
| janma miti | जन्म मिति | yes | Form phrase. |
| sifaris patra | सिफारिस पत्र | yes | |
| nagarikta sifaris | नागरिकता सिफारिस | yes | |
| rajaswa shakha | राजस्व शाखा | yes | |
| rajaswa bibhag | राजस्व विभाग | yes | |
| kar karyalaya | कर कार्यालय | yes | |
| ward karyalaya | वडा कार्यालय / ward कार्यालय | yes | Preference for `ward`. |
| malpot karyalaya | मालपोत कार्यालय | yes | |
| bhumi sudhar | भूमि सुधार | yes | |
| darta chalani | दर्ता चलानी | yes | |
| darta chalani kitab | दर्ता चलानी किताब | yes | |
| suchana adhikari | सूचना अधिकारी | yes | |
| karmachari bibaran | कर्मचारी विवरण | yes | |
| baithak nirnaya | बैठक निर्णय | yes | |
| nirnaya ra prastav | निर्णय र प्रस्ताव | yes | |
| pramanpatra vitaran | प्रमाणपत्र वितरण | yes | |
| sahayata kaksha | सहायता कक्ष | yes | |
| nagarik sahayata kaksha | नागरिक सहायता कक्ष | yes | |
| sewa kendra | सेवा केन्द्र | yes | |
| sthaniya taha | स्थानीय तह | yes | |
| gaupalika karyalaya | गाउँपालिका कार्यालय | yes | |
| nagarpalika karyalaya | नगरपालिका कार्यालय | yes | |
| gunaso sunuwai | गुनासो सुनुवाइ | yes | |
| pratibedan pes garnu | प्रतिवेदन पेश गर्नु | yes | |
| kharcha bibaran | खर्च विवरण | yes | |
| bajet nikasa | बजेट निकासा | yes | |
| bhuktani sifaris | भुक्तानी सिफारिस | yes | |
| basai sarai kagaj | बसाइ सराइ कागज | yes | |
| sewa prabah sudhar | सेवा प्रवाह सुधार | yes | |

### 5.2 Education Phrases

| Romanized phrase | Unicode candidate | Suggest as phrase | Notes |
| --- | --- | --- | --- |
| shiksha mantralaya | शिक्षा मन्त्रालय | yes | |
| pathyakram bikas kendra | पाठ्यक्रम विकास केन्द्र | yes | |
| bidhyalaya byabasthapan samiti | विद्यालय व्यवस्थापन समिति | yes | |
| shikshak sewa | शिक्षक सेवा | yes | |
| vidyarthi pramanpatra | विद्यार्थी प्रमाणपत्र | yes | |
| pariksha niyantran | परीक्षा नियन्त्रण | yes | |
| pariksha form | परीक्षा form / परीक्षा फारम | yes | Preference. |
| exam form | exam form | yes | Usually preserve. |
| result publish bhayo | result publish भयो | yes | Mixed. |
| grade sheet | grade sheet / ग्रेड शीट | candidate | Preserve often. |
| admit card | admit card | candidate | Preserve often. |
| transcript lina | transcript लिन | candidate | Preserve often. |
| kaksha das ko result | कक्षा दस को result | yes | Mixed. |
| pradhyapak sanga bhela | प्राध्यापकसँग भेला | yes | |
| pathyakram paribartan | पाठ्यक्रम परिवर्तन | yes | |
| talimmukhi karyakram | तालिममुखी कार्यक्रम | yes | |

### 5.3 Health Phrases

| Romanized phrase | Unicode candidate | Suggest as phrase | Notes |
| --- | --- | --- | --- |
| swasthya karyalaya | स्वास्थ्य कार्यालय | yes | |
| swasthya bima | स्वास्थ्य बीमा | yes | |
| doctor ko prescription | doctor को prescription / डाक्टरको prescription | candidate | Preserve medicine names. |
| xray report | X-ray report | candidate | Preserve X-ray. |
| hospital report | hospital report / अस्पताल report | candidate | Preference. |
| janch garna parcha | जाँच गर्न पर्छ | yes | |
| aushadhi lina | औषधि लिन | yes | |
| tika lagaune | टीका लगाउने | yes | |
| birami ko bibaran | बिरामीको विवरण | yes | |
| lab report | lab report | candidate | Preserve often. |

### 5.4 Tech/Digital Phrases

| Romanized phrase | Candidate | Policy |
| --- | --- | --- |
| file upload bhayena | file upload भएन / फाइल अपलोड भएन | Preference. |
| PDF upload garna milena | PDF upload गर्न मिलेन | Preserve PDF. |
| email pathaideu | email पठाइदेऊ | Preserve email token/address. |
| website khulena | website खुलेन / वेबसाइट खुलेन | Preference. |
| system crash bhayo | system crash भयो / सिस्टम crash भयो | Preference. |
| online form bharne | online form भर्ने / अनलाइन फारम भर्ने | Preference. |
| password birse | password बिर्से | Preserve/secure. |
| username milena | username मिलेन | Preserve. |
| API error aayo | API error आयो | Preserve. |
| GitHub ma issue hal | GitHub मा issue हाल | Preserve GitHub. |
| file pathaunu | file पठाउनु / फाइल पठाउनु | Preference. |
| data entry ma galti | data entry मा गल्ती | Preserve/preference. |
| scan garera pathaunu | scan गरेर पठाउनु / स्क्यान गरेर पठाउनु | Preference. |
| printer chaldaina | printer चल्दैन / प्रिन्टर चल्दैन | Preference. |

### 5.5 Everyday Phrases

| Romanized phrase | Unicode candidate |
| --- | --- |
| k gardai chau | के गर्दै छौ |
| kasto cha | कस्तो छ |
| ghar aaune | घर आउने |
| bholi bhetumla | भोलि भेटौँला |
| malai thaha chaina | मलाई थाहा छैन |
| ramro lagyo | राम्रो लाग्यो |
| dherai dhanyabad | धेरै धन्यवाद |
| mero naam | मेरो नाम |
| tapai kaha hunuhuncha | तपाईं कहाँ हुनुहुन्छ |
| kaam sakiyo | काम सकियो |
| aba ke garne | अब के गर्ने |
| ma aaudai chu | म आउँदै छु |
| voli aaunu | भोलि आउनु |
| sanchai chau | सञ्चै छौ |
| mitho lagyo | मिठो लाग्यो |
| samaya cha | समय छ |
| ek choti hernus | एकचोटि हेर्नुस |
| mero ni huncha | मेरो पनि हुन्छ |
| kina yesto bhayo | किन यस्तो भयो |
| kehi chaina | केही छैन |

### 5.6 Social/Informal Phrases

| Romanized phrase | Unicode candidate | Notes |
| --- | --- | --- |
| k xa | के छ | Chat. |
| k gardai xau | के गर्दै छौ | Chat. |
| hunxa ni | हुन्छ नि | |
| la thik xa | ल ठीक छ | `la` may preserve. |
| aba ta sakina | अब त सकिन | |
| maya lagcha | माया लाग्छ | |
| ramailo vayo | रमाइलो भयो | |
| ma aaudai xu | म आउँदै छु | |
| voli auxu | भोलि आउँछु | |
| msg gara hai | msg गर है | Preserve `msg`. |

## 6. Mixed Nepali-English Data

### 6.1 Preserve-Always English Tokens

These should usually stay English or byte-exact:

| Token class | Examples | Reason |
| --- | --- | --- |
| Acronyms | PDF, NID, PAN, VAT, URL, ID, DOB, API, HTML, CSS, JS, RAM, CPU, OTP, SMS, SIM, QR, PIN, CV, GPS, NGO, INGO, ATM, QR, UPI, CCTV, VPN, WiFi, USB | Semantic loss or ambiguity if transliterated. |
| Brands/platforms | Google, Facebook, Instagram, YouTube, GitHub, Gmail, WhatsApp, Viber, Zoom, Teams | Names/brands. |
| Credentials | username, password, login, OTP, PIN | Security and technical precision. |
| File artifacts | .pdf, .docx, .xlsx, file names, paths, URLs | Protected tokens. |
| Addresses/links | email addresses, URLs, domains | Must preserve. |
| Form identifiers | Form No., ward-05, ticket IDs, application numbers | Protected. |
| Code tokens | npm, git, branch names, API endpoints, HTML tags | Must preserve. |

### 6.2 Convert-Usually Loanwords

| English/Romanized | Unicode | Default |
| --- | --- | --- |
| computer | कम्प्युटर | convert |
| mobile | मोबाइल | convert |
| internet | इन्टरनेट | convert |
| digital | डिजिटल | convert |
| printer | प्रिन्टर | convert |
| hospital | अस्पताल | convert if Nepali prose |
| doctor | डाक्टर | convert if Nepali prose |
| bank | बैंक | convert in finance context |
| bus | बस | convert |
| ticket | टिकट | convert in transport context |
| police | प्रहरी / पुलिस | candidate |
| college | कलेज | convert |
| campus | क्याम्पस | convert |
| class | कक्षा / क्लास | context |
| project | प्रोजेक्ट / परियोजना | candidate |
| meeting | बैठक / meeting | context |
| office | अफिस / कार्यालय | candidate |
| market | बजार / मार्केट | candidate |
| training | तालिम / training | candidate |
| program | कार्यक्रम / program | candidate |
| service | सेवा / service | context |
| online | अनलाइन | candidate |
| form | फारम | candidate |
| file | फाइल | candidate |
| report | रिपोर्ट | candidate |
| system | सिस्टम | candidate |
| record | रेकर्ड | candidate |
| upload | अपलोड | candidate |
| download | डाउनलोड | candidate |
| submit | सबमिट | candidate |
| scan | स्क्यान | candidate |
| print | प्रिन्ट | candidate |
| copy | कपी / copy | candidate |
| photo | फोटो | candidate |
| video | भिडियो | candidate |
| message | मेसेज | candidate |
| number | नम्बर | convert in admin context |

### 6.3 Preference-Based Tokens

| Token | Preserve example | Convert example | Product rule |
| --- | --- | --- | --- |
| file | `file pathaunu` | `फाइल पठाउनु` | Candidate; learn preference. |
| form | `NID form` | `NID फारम` | Candidate; domain preference. |
| submit | `submit bhayena` | `सबमिट भएन` | Candidate. |
| upload | `upload garna` | `अपलोड गर्न` | Candidate. |
| download | `download gare` | `डाउनलोड गरे` | Candidate. |
| report | `lab report` | `रिपोर्ट` | Candidate. |
| record | `record hernus` | `रेकर्ड हेर्नुस` | Candidate. |
| online | `online form` | `अनलाइन फारम` | Candidate. |
| office | `office copy` | `अफिस` / `कार्यालय` | Context. |
| system | `system slow cha` | `सिस्टम slow छ` | Candidate. |
| print | `print garne` | `प्रिन्ट गर्ने` | Candidate. |
| scan | `scan garne` | `स्क्यान गर्ने` | Candidate. |
| message | `message gara` | `मेसेज गर` | Candidate. |
| call | `call garumla` | `कल गरौँला` | Candidate. |
| meeting | `meeting pachi` | `बैठकपछि` | Candidate/context. |
| result | `result publish` | `नतिजा प्रकाशित` | Candidate/formality. |
| grade | `grade sheet` | `ग्रेड शीट` | Candidate. |
| transcript | `transcript lina` | `ट्रान्सक्रिप्ट लिन` | Candidate. |
| admit card | `admit card` | `प्रवेश पत्र` | Candidate/formality. |
| bank | `bank account` | `बैंक खाता` | Candidate/context. |
| account | `account kholne` | `खाता खोल्ने` | Candidate/context. |
| branch | `branch office` | `शाखा कार्यालय` | Candidate/context. |
| copy | `office copy` | `कपी` | Candidate. |
| photo | `photo upload` | `फोटो upload` | Candidate. |
| passport | `passport form` | `पासपोर्ट फारम` | Candidate. |
| license | `license renew` | `लाइसेन्स renew` | Candidate. |
| token | `token number` | `टोकन नम्बर` | Candidate. |
| schedule | `schedule milena` | `तालिका मिलेन` | Candidate/formality. |
| notice | `notice aayo` | `सूचना आयो` | Candidate/formality. |
| update | `update gara` | `अपडेट गर` | Candidate. |
| settings | `settings khol` | `सेटिङ खोल` | Candidate. |

### 6.4 Context-Dependent Tokens

| Form | Candidate meanings | Context rule |
| --- | --- | --- |
| ram | राम / RAM | Tech context preserves RAM; name context converts. |
| ma | म / मा | Standalone subject vs postposition. |
| pani | पनि / पानी | Additive/discourse vs water noun. |
| bank | बैंक / bank | Nepali finance prose vs English institution phrase. |
| class | कक्षा / class | School grade vs programming/UI class. |
| file | फाइल / file | Document in Nepali prose vs filename/code. |
| form | फारम / form | Admin prose vs web UI/form ID. |
| pan | पान / PAN | Food leaf vs tax acronym. |
| vat | VAT / भ्याट | Acronym vs Nepali loanword. |
| mail | मेल / mail | Email vs physical mail context. |

### 6.5 Mixed Sentence Examples

All examples below are synthetic or internal seed examples for policy design unless a source ID is attached in a later corpus build.

| ID | Input | Candidate output | Preserve | Preference/context |
| --- | --- | --- | --- | --- |
| mix_001 | mero NID form submit bhayena | मेरो NID form submit भएन | NID | form, submit |
| mix_002 | PDF upload garna milena | PDF upload गर्न मिलेन | PDF | upload |
| mix_003 | yo system slow cha | यो system slow छ | none | system |
| mix_004 | email pathaideu | email पठाइदेऊ | email | none |
| mix_005 | file pathaunu | file पठाउनु | none | file |
| mix_006 | online form bharne | online form भर्ने | none | online, form |
| mix_007 | password birse | password बिर्से | password | secure token |
| mix_008 | website khulena | website खुलेन | none | website |
| mix_009 | GitHub ma issue hal | GitHub मा issue हाल | GitHub | issue |
| mix_010 | API error aayo | API error आयो | API | error |
| mix_011 | ward-05 ko record hernus | ward-05 को record हेर्नुस | ward-05 | record |
| mix_012 | Form No. 2079-080 milena | Form No. 2079-080 मिलेन | Form No. | none |
| mix_013 | class 12 ko result aayo | class 12 को result आयो | none | class/result |
| mix_014 | admit card print garne | admit card print गर्ने | none | print |
| mix_015 | doctor ko prescription scan gara | doctor को prescription scan गर | none | doctor/prescription/scan |
| mix_016 | lab report upload gara | lab report upload गर | none | report/upload |
| mix_017 | meeting pachi call garumla | meeting पछि call गरौँला | none | meeting/call |
| mix_018 | mobile number rakhnus | mobile number राख्नुस | none | mobile/number |
| mix_019 | phone number milena | phone number मिलेन | none | phone/number |
| mix_020 | account verify bhayena | account verify भएन | none | account/verify |
| mix_021 | OTP aayena | OTP आएन | OTP | none |
| mix_022 | PAN number halnus | PAN number हाल्नुस | PAN | number |
| mix_023 | VAT bill chahiyo | VAT bill चाहियो | VAT | bill |
| mix_024 | QR scan garna milena | QR scan गर्न मिलेन | QR | scan |
| mix_025 | login garna sakina | login गर्न सकिन | login | none |
| mix_026 | username wrong cha | username wrong छ | username | wrong |
| mix_027 | document ma naam milena | document मा नाम मिलेन | none | document |
| mix_028 | Excel report ma bibaran | Excel report मा विवरण | Excel | report |
| mix_029 | Word file ko suchana | Word file को सूचना | Word | file |
| mix_030 | data entry ma galti | data entry मा गल्ती | none | data/entry |
| mix_031 | printer chaldaina | printer चल्दैन | none | printer |
| mix_032 | internet slow cha | internet slow छ | none | internet |
| mix_033 | online payment bhayena | online payment भएन | none | online/payment |
| mix_034 | bank account kholne | bank account खोल्ने | none | bank/account |
| mix_035 | license renew garne | license renew गर्ने | none | license/renew |
| mix_036 | passport form bharne | passport form भर्ने | none | passport/form |
| mix_037 | ticket counter ma line cha | ticket counter मा line छ | none | ticket/counter/line |
| mix_038 | video upload gareko chu | video upload गरेको छु | none | video/upload |
| mix_039 | photo attach garne | photo attach गर्ने | none | photo/attach |
| mix_040 | message gareko ho | message गरेको हो | none | message |
| mix_041 | call receive bhayena | call receive भएन | none | call/receive |
| mix_042 | notification aayena | notification आएन | none | notification |
| mix_043 | app crash bhayo | app crash भयो | app | crash |
| mix_044 | update pachhi problem aayo | update पछि problem आयो | none | update/problem |
| mix_045 | browser ma open hunna | browser मा open हुन्न | none | browser/open |
| mix_046 | server down cha | server down छ | server | down |
| mix_047 | database connect bhayena | database connect भएन | database | connect |
| mix_048 | branch office ma janu | branch office मा जानु | none | branch/office |
| mix_049 | office copy pathaunu | office copy पठाउनु | none | office/copy |
| mix_050 | original certificate lyau | original certificate ल्याऊ | none | certificate |
| mix_051 | training schedule hernus | training schedule हेर्नुस | none | training/schedule |
| mix_052 | feedback form submit garnu | feedback form submit गर्नु | none | feedback/form/submit |
| mix_053 | support ticket kholnus | support ticket खोल्नुस | support | ticket |
| mix_054 | dashboard ma error cha | dashboard मा error छ | dashboard | error |
| mix_055 | PDF report print garnu | PDF report print गर्नु | PDF | report/print |
| mix_056 | zoom meeting join garne | Zoom meeting join गर्ने | Zoom | meeting/join |
| mix_057 | Google Drive link pathaunu | Google Drive link पठाउनु | Google Drive | link |
| mix_058 | facebook ma message aayo | Facebook मा message आयो | Facebook | message |
| mix_059 | Instagram post hernus | Instagram post हेर्नुस | Instagram | post |
| mix_060 | YouTube video khulena | YouTube video खुलेन | YouTube | video |

### 6.6 Product Rules for Mixed Typing

1. Protected tokens are detected before transliteration.
2. English acronyms and code-like tokens preserve byte-exact form.
3. User preference tokens are shown as alternatives, not forced.
4. Domain context changes ranking: office context boosts `फारम`, tech UI context preserves `form`.
5. Personal memory may boost preference but must never override protected-token safety.
6. Secure input disables memory and proofread.
7. Candidate UI must expose ambiguity instead of silently choosing.

## 7. Ambiguity Database

### 7.1 Highly Ambiguous Words

Ambiguous forms are production-critical because they create silent corruption risk.

### 7.2 Context Rules

Rules should be probabilistic and conservative:

- `pani`: after noun/pronoun and before verb often `पनि`; near verbs like drink/fetch/boil often `पानी`.
- `ma`: if isolated subject before verb, `म`; if after noun/place, `मा`.
- `ram`: uppercase or tech context means `RAM`; person context means `राम`.
- `pan`: uppercase tax context means `PAN`; food context may be `पान`.
- `ko`: generally `को`, but compound attachment should be proofread separately.

### 7.3 Candidate Strategy

Default actions:

- high ambiguity: show candidates,
- protected/acronym ambiguity: preserve first if uppercase,
- social chat ambiguity: prefer user memory,
- office phrase ambiguity: phrase match beats token fallback.

### 7.4 Ambiguity Table

| Form | Candidates | Context needed | Default action |
| --- | --- | --- | --- |
| pani | पनि, पानी | discourse vs water | candidates |
| ma | म, मा | subject vs locative/postposition | candidates |
| ram | राम, RAM | name vs computer memory | preserve uppercase; candidates lowercase |
| sita | सीता, sita | name vs Latin text | candidates |
| bank | बैंक, bank | finance prose vs English phrase | preference |
| file | फाइल, file | loanword vs technical token | preference |
| form | फारम, form | admin vs UI token | preference |
| pan | पान, PAN | food vs tax acronym | preserve uppercase |
| vat | VAT, भ्याट | tax acronym vs spoken loanword | preserve uppercase |
| mail | मेल, mail | email vs physical/social | preference |
| class | कक्षा, class, क्लास | education vs code/UI | context |
| copy | कपी, copy | education/office vs command | context |
| report | रिपोर्ट, report | Nepali prose vs technical artifact | preference |
| system | सिस्टम, system | Nepali prose vs technical UI | preference |
| online | अनलाइन, online | Nepali prose vs UI term | preference |
| mobile | मोबाइल, mobile | Nepali prose vs brand/plan | convert usually |
| office | अफिस, कार्यालय, office | colloquial vs formal vs English | candidates |
| service | सेवा, service | government vs tech term | context |
| program | कार्यक्रम, program | event vs code | context |
| project | परियोजना, project | formal vs tech | context |
| issue | मुद्दा, issue | legal/problem vs GitHub issue | context |
| branch | शाखा, branch | office branch vs code branch | context |
| commit | commit, कमिट | Git vs promise/action | preserve in dev context |
| token | टोकन, token | queue vs auth token | context |
| scan | स्क्यान, scan | loanword vs command/UI | preference |
| print | प्रिन्ट, print | loanword vs UI command | preference |
| call | कल, call | phone vs code call | context |
| message | मेसेज, message | chat vs technical object | preference |
| link | लिंक, link | URL token vs loanword | preserve if URL-like |
| post | पोस्ट, post | social post vs postposition? | context |
| user | प्रयोगकर्ता, user | formal vs UI | context |
| account | खाता, account | bank/account vs user account | context |
| password | password | secure token | preserve |
| code | code, कोड | programming vs OTP/code | context |
| server | server, सर्भर | tech token | preference |
| data | data, डाटा | tech | preference |
| entry | entry, इन्ट्री | office/tech | preference |
| result | नतिजा, result | formal vs school mixed | context |
| grade | grade, ग्रेड | education | preference |
| paper | paper, पेपर, कागज | exam/document | context |
| answer | उत्तर, answer | education vs English | context |
| sir | sir, सर | honorific | preference |
| madam | madam, म्याडम | honorific | preference |
| guru | गुरु, guru | title vs English loan | context |
| ghar | घर | low ambiguity | convert |
| kar | कर, car | tax vs vehicle English | context |
| kal | काल, कल? | time/call? | candidates |
| tala | तला, तल | floor/down | candidates |
| mathi | माथि | low ambiguity | convert |
| bhitra | भित्र | low ambiguity | convert |
| bahira | बाहिर | low ambiguity | convert |
| kura | कुरा | low ambiguity | convert |
| kuraa | कुरा | variant | convert |
| khana | खाना | eat/food | convert |
| pani khana | पानी खाना | phrase context | phrase |

## 8. Domain-Specific Romanized Data

### 8.1 Government/Admin

Core terms:

`jilla`, `prashasan`, `karyalaya`, `nagarikta`, `pramanpatra`, `sifaris`, `darta`, `chalani`, `rajaswa`, `shakha`, `malpot`, `bhumi`, `sudhar`, `ward`, `wada`, `sthaniya`, `taha`, `gaupalika`, `nagarpalika`, `mahanagarpalika`, `parichaypatra`, `sahayata`, `gunaso`, `sunuwai`, `pratibedan`, `bhuktani`, `bajet`, `nikasa`.

Product rule: build a high-priority office phrase trie.

### 8.2 Education

Core terms:

`shiksha`, `bidhyalaya`, `vidyalaya`, `vidyarthi`, `pariksha`, `pathyakram`, `bikas`, `kendra`, `shikshak`, `sewa`, `result`, `grade`, `transcript`, `admit card`, `exam form`, `kaksha`, `campus`, `pradhyapak`, `bibhag`.

Product rule: preserve many English education artifacts by default.

### 8.3 Health

Core terms:

`swasthya`, `swastha`, `janch`, `aushadhi`, `doctor`, `hospital`, `prescription`, `xray`, `report`, `bima`, `birami`, `lab`, `tika`, `khop`, `jwar`, `khoki`, `ausadhi`, `upachar`.

Product rule: preserve acronyms, medicine names, and report identifiers.

### 8.4 Legal

Core terms:

`kanun`, `kanoon`, `adalat`, `mudda`, `faisala`, `ujuri`, `sahamati`, `patra`, `likhit`, `jawaf`, `sarbajanik`, `praman`, `sambidhan`, `samvidhan`, `anusar`, `niyam`, `ain`, `hak`, `adhikar`.

Product rule: formal ranking should prefer standard spellings and avoid casual `x` variants unless query demands.

### 8.5 Tech

Core terms:

`file`, `upload`, `download`, `email`, `website`, `system`, `password`, `username`, `login`, `logout`, `API`, `HTML`, `CSS`, `JavaScript`, `GitHub`, `server`, `database`, `browser`, `app`, `update`, `settings`, `notification`, `OTP`.

Product rule: protected-token and preserve-English detector must run before transliteration.

### 8.6 Everyday Communication

Core terms:

`mero`, `timi`, `tapai`, `k`, `ke`, `kasto`, `ramro`, `dherai`, `dhanyabad`, `ghar`, `bholi`, `aaja`, `hijo`, `aaune`, `jane`, `garne`, `bhayo`, `huncha`, `chaina`, `thaha`, `sanchai`, `maya`.

Product rule: candidate model should learn personal spelling preference quickly.

### 8.7 Names/People

Names require high caution:

- do not proofread names aggressively,
- never infer real identity from name variants,
- allow user personal dictionary,
- remember selected name spelling locally only,
- avoid collecting full names from public social data unless consented or already in open name lists with license.

## 9. Dataset Schema Proposal

### 9.1 Word Alias JSONL

```json
{
  "id": "word_000001",
  "romanized": "swasthya",
  "unicodeCandidates": ["स्वास्थ्य"],
  "domain": ["health", "general"],
  "confidence": 0.98,
  "sources": ["source_id_001", "source_id_internal_alias"],
  "variantType": "standard",
  "reuseStatus": "reusable-under-license",
  "notes": "common spelling; verify corpus frequency"
}
```

### 9.2 Phrase Alias JSONL

```json
{
  "id": "phrase_000001",
  "romanized": "jilla prashasan karyalaya",
  "unicodeCandidates": ["जिल्ला प्रशासन कार्यालय"],
  "domain": ["government", "office"],
  "confidence": 0.99,
  "sources": ["source_id_internal_phrase", "source_id_public_pattern"],
  "suggestAsPhrase": true,
  "reuseStatus": "seed-human-review"
}
```

### 9.3 Mixed Sentence JSONL

```json
{
  "id": "mixed_000001",
  "input": "mero NID form submit bhayena",
  "expectedCandidates": [
    "मेरो NID form submit भएन",
    "मेरो NID फारम सबमिट भएन"
  ],
  "preserveTokens": ["NID"],
  "preferenceTokens": ["form", "submit"],
  "domain": ["government", "digital"],
  "confidence": 0.85,
  "reuseStatus": "synthetic-seed",
  "notes": "preference-dependent mixed typing"
}
```

### 9.4 Ambiguity JSONL

```json
{
  "id": "amb_000001",
  "form": "pani",
  "candidates": ["पनि", "पानी"],
  "contextRules": [
    "after noun phrase and before verb often additive पनि",
    "object of drink/fetch/water context often पानी"
  ],
  "defaultAction": "candidates",
  "confidence": 0.6
}
```

### 9.5 Protected Token JSONL

```json
{
  "id": "protected_000001",
  "pattern": "NID",
  "type": "acronym",
  "policy": "preserve",
  "examples": ["mero NID form"],
  "reuseStatus": "synthetic-seed",
  "notes": "should not transliterate"
}
```

### 9.6 Loanword Preference JSONL

```json
{
  "id": "loan_000001",
  "english": "computer",
  "unicodeCandidates": ["कम्प्युटर"],
  "defaultPolicy": "convert",
  "preferenceAllowed": true,
  "domain": ["tech", "general"],
  "confidence": 0.95
}
```

## 10. Annotation Guidelines

### 10.1 Token Labels

| Label | Meaning |
| --- | --- |
| `ne-roman-convert` | Romanized Nepali token with definite Unicode candidate. |
| `ne-roman-candidate` | Romanized token with multiple likely Unicode candidates. |
| `en-preserve` | English/acronym/code token should remain Latin. |
| `loan-convert` | English loanword usually converted to Nepali. |
| `loan-preference` | User preference decides preserve vs convert. |
| `protected` | URL, email, ID, file path, code, number, secure token. |
| `name-candidate` | Name/surname; candidate and memory only. |
| `unknown` | Not enough evidence. |

### 10.2 Sentence Labels

- pure Romanized Nepali,
- mixed Nepali-English,
- English sentence with Nepali insertions,
- formal,
- informal,
- office,
- social,
- tech,
- education,
- health,
- legal/admin.

### 10.3 Confidence Labels

| Label | Numeric range | Use |
| --- | --- | --- |
| high | 0.85-1.0 | Strong candidate or phrase. |
| medium | 0.55-0.84 | Show candidate but avoid auto-commit. |
| low | 0.20-0.54 | Diagnostic/helper only. |
| unknown | 0-0.19 | Preserve or ask. |

### 10.4 Source Labels

- official,
- academic/open dataset,
- open-source,
- public discussion,
- app review,
- social/anecdotal,
- internal fixture,
- synthetic seed.

### 10.5 Reuse and License Labels

| Label | Meaning |
| --- | --- |
| reusable-under-license | Raw text can be used under explicit license. |
| pattern-only | Do not store raw text; store derived pattern. |
| quote-only | Short quoted snippets only with citation. |
| consent-required | Needs explicit user consent. |
| not-reusable | Do not include raw text. |
| synthetic-seed | Created for tests or policy design; not real frequency evidence. |

## 11. Data Quality Strategy

### 11.1 Deduplication

Deduplicate at multiple levels:

1. exact raw text,
2. cleaned text,
3. normalized Romanized text,
4. Unicode candidate,
5. phrase alias,
6. protected-token patterns.

Do not dedupe candidate labels as if they are text uniqueness. `स्वास्थ्य` with labels `swasthya` and `swastha` is one Unicode candidate with merged aliases.

### 11.2 Normalization

Recommended normalization fields:

- lowercase Romanized form,
- punctuation-stripped lookup key,
- whitespace-normalized phrase,
- Devanagari NFC-normalized candidate,
- protected spans replaced by typed placeholders for feature extraction,
- original text preserved only if legally reusable.

### 11.3 Source Traceability

Every reusable row must have:

- `source_id`,
- `source_url`,
- `license`,
- `collection_method`,
- `collected_at`,
- `reuse_status`,
- `pii_redaction_status`,
- `reviewer`.

### 11.4 Frequency Estimation

Frequency should be estimated separately by source class:

- open transliteration lexicon count,
- public social count,
- office/admin fixture count,
- pilot opt-in count,
- user personal frequency.

Never mix personal user memory into global frequency without explicit opt-in.

### 11.5 Human Review Queue

Send these to human review:

- high-frequency ambiguous forms,
- names/surnames,
- government office terms,
- loanword policy conflicts,
- unexpected protected-token conversions,
- new Traditional physical layout mappings,
- dictionary meanings from any new source.

### 11.6 Bias and Coverage Risks

Likely coverage gaps:

- rural vs urban spelling,
- diaspora spelling,
- age differences,
- mobile vs desktop typing,
- office vs chat style,
- regional terms,
- ethnic/language community names,
- code-heavy developer text,
- sensitive health/legal vocabulary.

## 12. Product Implications for Lekh Keyboard

### 12.1 Romanized Candidate Generation

The engine should combine:

- exact alias lookup,
- phrase trie,
- prefix phrase completion,
- phonetic fallback,
- spelling variant expansion,
- protected-token passthrough,
- personal dictionary,
- correction memory.

### 12.2 Romanized Helper Suggestions

Helper suggestions should refine Romanized input:

- `swas` -> `swasthya`, `swastha`, `swasthy`,
- `karya` -> `karyalaya`, `karyakram`,
- `pra` -> `prashasan`, `praman`, `pradesh`.

They should not dominate Unicode candidates.

### 12.3 Mixed Nepali-English Smart Mode

Mixed mode should preserve:

- acronyms,
- IDs,
- URLs/emails,
- file names/extensions,
- code tokens,
- brands,
- credentials.

It should candidate-rank:

- loanwords,
- UI terms,
- education terms,
- government document terms.

### 12.4 Loanword Preferences

Default policy:

- preserve in technical/code contexts,
- convert in natural Nepali prose when common,
- show both for office/digital forms,
- learn per-user preference locally.

### 12.5 Proofread

Proofread should be conservative:

- high-confidence curated corrections can appear as candidates,
- medium confidence as hints,
- low confidence diagnostic only,
- names protected,
- personal dictionary suppresses unwanted corrections,
- protected tokens skipped.

### 12.6 Dictionary

Phase 1 dictionary should provide:

- canonical spelling,
- Romanized aliases,
- variants,
- domain tags,
- no meanings unless licensed,
- personal dictionary entries,
- prefer/never-suggest controls.

### 12.7 Personal Memory

Memory should record:

- chosen candidate,
- rejected top candidate,
- mode,
- context window without sensitive text,
- frequency,
- pinned/preferred/never-suggest.

Memory must not record secure field text or protected tokens as editable content.

### 12.8 Candidate Ranking

Ranking should consider:

- exact match,
- prefix match,
- phrase frequency,
- domain,
- context,
- memory,
- ambiguity,
- candidate type,
- protected-token safety,
- personal preference.

Latency should not be part of linguistic ranking. Optimize latency through caching and caps.

## 13. Source Database

| ID | Platform | URL/source | Date observed | Source type | Reliability | Relevance | Key data extracted | Product implication | Reuse status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S001 | arXiv / LREC | [Dakshina Dataset](https://arxiv.org/abs/2007.01176) | 2026-06-08 | academic dataset paper | 5 | Romanized/native South Asian parallel data | Shows value of romanization lexicons and sentence transliteration. | Use for base transliteration if language/license fit. | Check dataset license; paper reference reusable. |
| S002 | GitHub / AI4Bharat | [IndicXlit](https://github.com/AI4Bharat/IndicXlit) | 2026-06-08 | open-source model/dataset | 4 | Roman-to-native transliteration for Nepali among 21 languages | Confirms large transliteration pair approach and model format. | Candidate generator baseline; compare alias behavior. | License review required before ingestion. |
| S003 | Hugging Face | [Boredoom17/Nepali-Flow-Roman](https://huggingface.co/datasets/Boredoom17/Nepali-Flow-Roman) | 2026-06-08 | public dataset | 4 | 307,999 Latin-script Nepali YouTube comments, CC BY 4.0 page label | Real social Romanized text, messy spelling, mixed language. | Strong source for social pattern mining after PII review. | License page says CC BY 4.0; still run PII/ToS review. |
| S004 | Hugging Face | [Saugatkafley/Nepali-Roman-Transliteration](https://huggingface.co/datasets/Saugatkafley/Nepali-Roman-Transliteration) | 2026-06-08 | public dataset | 4 | 2.4M transliteration rows, MIT page label | Word-level native/Roman pairs. | Base alias expansion and variant mining. | License page says MIT; inspect origin/provenance before ingestion. |
| S005 | Hugging Face | [syubraj/roman2nepali-transliteration](https://huggingface.co/datasets/syubraj/roman2nepali-transliteration) | 2026-06-08 | public dataset | 4 | 2.4M rows, MIT page label | Word-level roman/native dictionary-like pairs. | Alias candidates and model training reference. | License page says MIT; provenance review required. |
| S006 | Hugging Face | [nirajandhakal/Devnagari-Romanized-Pair](https://huggingface.co/datasets/nirajandhakal/Devnagari-Romanized-Pair) | 2026-06-08 | public dataset | 3 | 959 sentence pairs | Sentence-level Devanagari/Romanized alignment. | Phrase and sentence transliteration evaluation. | Check dataset card/license before reuse. |
| S007 | ACL Anthology | [Language Preference for Expression of Sentiment for Nepali-English](https://aclanthology.org/2023.calcs-1.3.pdf) | 2026-06-08 | academic paper | 5 | Nepali-English code-switched YouTube comments | Confirms YouTube code-switching data and social language preference. | Mixed typing and sentiment/formality analysis. | Paper reference; dataset license separately required. |
| S008 | arXiv | [Code-Mixed Nepali-English Abusive Language Dataset](https://arxiv.org/abs/2504.21026) | 2026-06-08 | academic paper | 4 | 5K Nepali-English code-mixed comments | Confirms code-mixed social corpus exists. | Pattern awareness; do not import toxic text into keyboard lexicon blindly. | Paper reference; dataset reuse uncertain. |
| S009 | UK/NGA style PDF | [BGN/PCGN Romanization of Nepali](https://assets.publishing.service.gov.uk/media/5ab4e364e5274a1aa5933450/ROMANIZATION_OF_NEPALI.pdf) | 2026-06-08 | official romanization reference | 5 | Standard romanization of Nepali names | Useful for formal name mapping, not social spelling. | Name alias fallback, not primary keyboard behavior. | Reference only. |
| S010 | GitHub | [pemagrg1/Nepali-Datasets](https://github.com/pemagrg1/Nepali-Datasets) | 2026-06-08 | dataset index | 3 | Lists Nepali NLP resources including transliteration and code-switching | Discovery registry. | Track candidate datasets and licenses. | Index MIT; linked resources vary. |
| S011 | Google Play | [Hamro Nepali Keyboard](https://play.google.com/store/apps/details?id=com.hamrokeyboard) | 2026-06-08 | public app listing/reviews | 2 | Keyboard layouts, reviews, data safety, typing complaints | Product pain and layout expectations. | Do not copy reviews; summarize issues. | Pattern-only/quote-only. |
| S012 | Apple App Store | [Hamro Nepali Keyboard Reviews](https://apps.apple.com/us/app/1276952753?platform=iphone&see-all=reviews) | 2026-06-08 | public reviews | 2 | iOS keyboard UX complaints | Keyboard UI/preserve native feel. | Pattern-only/quote-only. |
| S013 | Keyman forum | [Font not working - Nepali Romanized Keyboard](https://community.software.sil.org/t/font-not-working/11000) | 2026-06-08 | public support thread | 2 | User expects Romanized keyboard to produce Nepali text on Windows | Desktop support issues. | Pattern-only. |
| S014 | Reddit | [Romanized Nepali dataset discussion](https://www.reddit.com/r/Nepal/comments/1971eli) | 2026-06-08 | public discussion | 2 | Demand for chat-style Romanized corpus | Corpus demand and examples like `Ke cha`, `k xa`. | Pattern-only. |
| S015 | Reddit | [Romanization ambiguity discussion](https://www.reddit.com/r/Nepal/comments/eaxoha) | 2026-06-08 | public discussion | 2 | Users note lack of standard romanization | Ambiguity strategy. | Pattern-only. |
| S016 | Reddit | [Traditional vs Romanized typing discussion](https://www.reddit.com/r/Nepal/comments/12rt004) | 2026-06-08 | public discussion | 2 | Keyboard mode choice pain | Product mode selection. | Pattern-only. |
| S017 | Lekh repo | `src/data/aliases/romanized-aliases.tsv` | 2026-06-08 | internal seed | 1 | Curated aliases | Bootstrap candidate coverage. | Internal only. |
| S018 | Lekh repo | `src/data/phrases/romanized-phrases.tsv` | 2026-06-08 | internal seed | 1 | Office/domain phrase aliases | Phrase trie seed. | Internal only. |
| S019 | Lekh repo | `bench/fixtures/typing-session/*.jsonl` | 2026-06-08 | internal benchmarks | 1 | Typing-session expected behavior | Regression and product validation. | Internal only. |
| S020 | Lekh repo | `data/lexicon/english-preserve/*.jsonl` and `data/lexicon/loanwords/*.jsonl` | 2026-06-08 | internal policy lexicon | 1 | Preserve/acronym/loanword policies | Mixed typing routing. | Internal only. |

## 14. Data Tables

### 14.1 Protected Tokens

| ID | Pattern | Type | Policy |
| --- | --- | --- | --- |
| protected_001 | PDF | acronym | preserve |
| protected_002 | NID | acronym | preserve |
| protected_003 | PAN | acronym | preserve |
| protected_004 | VAT | acronym | preserve |
| protected_005 | URL | acronym | preserve |
| protected_006 | ID | acronym | preserve |
| protected_007 | DOB | acronym | preserve |
| protected_008 | API | acronym | preserve |
| protected_009 | HTML | acronym | preserve |
| protected_010 | CSS | acronym | preserve |
| protected_011 | JavaScript | language | preserve |
| protected_012 | GitHub | platform | preserve |
| protected_013 | Google | brand | preserve |
| protected_014 | Facebook | platform | preserve |
| protected_015 | Instagram | platform | preserve |
| protected_016 | YouTube | platform | preserve |
| protected_017 | Gmail | platform | preserve |
| protected_018 | OTP | security | preserve |
| protected_019 | PIN | security | preserve |
| protected_020 | password | security | preserve |
| protected_021 | username | security/UI | preserve |
| protected_022 | email address | structured token | preserve byte-exact |
| protected_023 | URL/link | structured token | preserve byte-exact |
| protected_024 | file extension | structured token | preserve byte-exact |
| protected_025 | file path | structured token | preserve byte-exact |
| protected_026 | Form No. | form label | preserve |
| protected_027 | ward-05 | identifier | preserve |
| protected_028 | ticket ID | identifier | preserve |
| protected_029 | application number | identifier | preserve |
| protected_030 | branch name/code | identifier | preserve in context |
| protected_031 | QR | acronym | preserve |
| protected_032 | SMS | acronym | preserve |
| protected_033 | SIM | acronym | preserve |
| protected_034 | USB | acronym | preserve |
| protected_035 | WiFi | acronym | preserve |
| protected_036 | VPN | acronym | preserve |
| protected_037 | CPU | acronym | preserve |
| protected_038 | RAM | acronym/name ambiguity | preserve uppercase |
| protected_039 | npm | developer token | preserve |
| protected_040 | git | developer token | preserve |

### 14.2 Loanword Preference Inventory

| ID | English | Unicode candidates | Default policy |
| --- | --- | --- | --- |
| loan_001 | computer | कम्प्युटर | convert |
| loan_002 | mobile | मोबाइल | convert |
| loan_003 | internet | इन्टरनेट | convert |
| loan_004 | digital | डिजिटल | convert |
| loan_005 | printer | प्रिन्टर | convert |
| loan_006 | file | फाइल | preference |
| loan_007 | form | फारम | preference |
| loan_008 | report | रिपोर्ट | preference |
| loan_009 | system | सिस्टम | preference |
| loan_010 | record | रेकर्ड | preference |
| loan_011 | upload | अपलोड | preference |
| loan_012 | download | डाउनलोड | preference |
| loan_013 | submit | सबमिट | preference |
| loan_014 | online | अनलाइन | preference |
| loan_015 | office | अफिस, कार्यालय | context |
| loan_016 | bank | बैंक | context |
| loan_017 | class | कक्षा, क्लास | context |
| loan_018 | grade | ग्रेड | preference |
| loan_019 | campus | क्याम्पस | preference |
| loan_020 | doctor | डाक्टर | context |
| loan_021 | hospital | अस्पताल | context |
| loan_022 | prescription | prescription | preserve/preference |
| loan_023 | lab | lab | preserve/preference |
| loan_024 | scan | स्क्यान | preference |
| loan_025 | print | प्रिन्ट | preference |
| loan_026 | photo | फोटो | preference |
| loan_027 | video | भिडियो | preference |
| loan_028 | message | मेसेज | preference |
| loan_029 | call | कल | preference |
| loan_030 | meeting | बैठक, meeting | context |
| loan_031 | project | परियोजना, project | context |
| loan_032 | program | कार्यक्रम, program | context |
| loan_033 | training | तालिम, training | context |
| loan_034 | service | सेवा, service | context |
| loan_035 | account | खाता, account | context |
| loan_036 | token | टोकन, token | context |
| loan_037 | license | लाइसेन्स | preference |
| loan_038 | passport | पासपोर्ट | preference |
| loan_039 | notice | सूचना, notice | context |
| loan_040 | schedule | तालिका, schedule | context |

### 14.3 Phrase Alias Seed Inventory

The phrase rows in Section 5 form the initial phrase alias seed inventory. Production ingestion should convert them to JSONL with `source`, `license`, `reviewStatus`, and corpus counts.

### 14.4 Names/Surnames Seed Inventory

Use names only for candidate generation and personal dictionaries. Do not infer identity.

| Romanized | Unicode candidates |
| --- | --- |
| prabin | प्रबिन, प्रवीण |
| praveen | प्रवीण |
| pravin | प्रविन |
| niraj | निरज |
| neeraj | नीरज |
| roshan | रोशन |
| laxmi | लक्ष्मी |
| lakshmi | लक्ष्मी |
| anita | अनिता |
| gita | गीता |
| sita | सीता |
| sushma | सुष्मा |
| srijana | सृजना |
| pratiksha | प्रतीक्षा |
| bishnu | विष्णु |
| gopal | गोपाल |
| deepak | दीपक |
| ashim | आशिम |
| manoj | मनोज |
| sunita | सुनिता |
| basnet | बस्नेत |
| bhandari | भण्डारी |
| poudel | पौडेल |
| paudel | पौडेल |
| poudyal | पौड्याल |
| shrestha | श्रेष्ठ |
| srestha | श्रेष्ठ |
| bhattarai | भट्टराई |
| bhattrai | भट्टराई |
| pokhrel | पोखरेल |
| pokharel | पोखरेल |
| ghimire | घिमिरे |
| adhikari | अधिकारी |
| adhikary | अधिकारी |
| khadka | खड्का |
| karki | कार्की |
| thapa | थापा |
| gurung | गुरुङ |
| rai | राई |
| limbu | लिम्बू |
| tamang | तामाङ |
| lama | लामा |
| dahal | दाहाल |
| koirala | कोइराला |
| niraula | निरौला |
| regmi | रेग्मी |
| sapkota | सापकोटा |
| shahi | शाही |
| maharjan | महर्जन |
| kc | केसी / KC |
| acharya | आचार्य |
| bhusal | भुसाल |
| niraula | निरौला |
| magar | मगर |
| chaudhary | चौधरी |
| chaudhari | चौधरी |
| yadav | यादव |
| sharma | शर्मा |
| upadhyay | उपाध्याय |
| subedi | सुवेदी |
| gautam | गौतम |
| poudyal | पौड्याल |

## 15. Final Data Strategy

### 15.1 Immediate Dataset to Build

Build these six datasets first:

1. `word_aliases.reviewed.jsonl`: open-license + internal-reviewed word aliases with domain tags.
2. `phrase_aliases.reviewed.jsonl`: phrase trie seeds for government, education, health, tech, everyday.
3. `mixed_sentence_policy.reviewed.jsonl`: synthetic + consented + open-license mixed typing examples.
4. `ambiguity.reviewed.jsonl`: ambiguous forms and context rules.
5. `protected_tokens.reviewed.jsonl`: acronyms, IDs, URLs, emails, file names, code tokens.
6. `loanword_preferences.reviewed.jsonl`: convert/preserve/preference policies.

### 15.2 Human Review Workflow

1. Candidate row enters `pending`.
2. Annotator labels conversion, domain, confidence, source, reuse status.
3. Reviewer checks source/license and linguistic validity.
4. Sensitive rows are redacted or converted to pattern-only.
5. High-risk ambiguous rows require two reviewers.
6. Approved rows enter `reviewed`.
7. Corpus counts are updated separately from personal memory.

### 15.3 Consent-Based User Data Collection

Pilot collection must be opt-in:

- user manually submits example,
- consent checkbox required,
- redaction instructions visible,
- fields: input, expected output, current output, mode, platform/app, protected token involved, consent status,
- no background text capture,
- no hidden telemetry,
- export/delete controls available.

### 15.4 What Not To Use

Do not use:

- private Facebook groups,
- private messages,
- closed Discord/WhatsApp chats,
- personal documents without consent,
- government IDs,
- medical/legal personal case text,
- copyrighted large comment dumps without license,
- unclear-license dictionaries,
- scraped dictionary meanings.

### 15.5 Next Research Pass

The next pass should produce actual counted corpus statistics:

1. License-approved download of open datasets.
2. PII redaction pipeline and manual audit.
3. Token frequency counts by domain/source.
4. Alias collision table.
5. Phrase frequency table.
6. Mixed-token preserve/convert/preference counts.
7. Top ambiguity contexts.
8. User study with consented examples from office, education, health, developer, and social users.
9. Human-reviewed Traditional layout source-of-truth if Traditional physical keyboard remains in scope.

Final recommendation: use this report as the data contract for Lekh Keyboard’s Romanized intelligence layer. Build the reusable seed datasets only from licensed/open/internal-reviewed sources, and treat public social examples as pattern evidence until a platform-compliant, anonymized, consent-aware corpus process is in place.
