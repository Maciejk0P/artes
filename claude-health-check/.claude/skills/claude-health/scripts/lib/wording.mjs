// Word lists, English and Slovak. They decide one thing: whether a sentence is written like an
// instruction. That narrows down which lines a reader is asked about; it proves nothing. Many of
// the English verbs are nouns as well ("export", "record", "test"), so a sentence that describes
// software can pass, and a verb that is missing lets an instruction through unseen. Whatever is
// found with these lists is therefore a candidate for a reader, never a finding.

// Words that carry no meaning of their own. Two lines that share only these do not share a term.
export const STOP_WORDS = new Set(
  (
    'always never must use using used not dont avoid should prefer run the and for with from that this these those ' +
    'when what which will your you are was were has have had can could would all any each every into onto over ' +
    'under than then them they their there here only also just more most some such very per via out off its ' +
    // Slovak: conjunctions, particles, prepositions, pronouns and forms of "to be".
    'vždy nikdy musí použi používaj nepoužívaj pre pri ako aby alebo ale keď tak tiež len iba nie áno som bol ' +
    'bola bolo byť mať ich jeho jej ten tie tento táto toto pod nad ' +
    'ani aby aj až ak ako ale bez boli bude budú cez či čo do ešte ho je jej jeho ich ju kde ktorá ktoré ktorý ' +
    'ktorí kto ku lebo má majú medzi mi mu my na nám nás než nich nim nič od on ona oni ono po pod potom pred ' +
    'preto pretože sa si so sú svoj svoje ta tam teda ten tej tento tieto tom tú tu ty tým už vo však vy za zo že ' +
    'viac menej veľmi každý každá každé všetky všetko všetci jeden jedna jedno dva tri okrem podľa proti kým ' +
    'pokiaľ hoci nech nielen sme ste som'
  ).split(' '),
);

// Verbs that open an instruction or a step: "Use tabs", "Run the tests", "Spusti testy".
const IMPERATIVE_EN =
  'add align allow announce answer append apply archive ask assume attach avoid back begin build bump call capture ' +
  'change check choose cite clean clear clone close collect commit compare compile configure confirm consider copy ' +
  'count create cut declare default define delete deploy describe disable document download draft drop edit enable ' +
  'end ensure escape exclude execute explain export extract fetch fill filter find finish fix flag follow format ' +
  'generate get give group handle ignore import include indent inline insert install keep label leave limit link ' +
  'lint list load log look make mark match measure mention merge migrate move name note notify number omit open ' +
  'order output pass pick pin place plan post prefer prefix prepare print propose publish pull push put quote raise ' +
  'read rebase record refer regenerate release reload remove rename repeat replace reply report request rerun reset ' +
  'resolve respect respond restart restore return reuse review revert rewrite run save say scan search select send ' +
  'set share ship show sign skip sort spell split squash stage start state stay stick stop store submit summarise ' +
  'summarize switch sync tag take tell test think treat trim try turn type undo update upgrade upload validate ' +
  'verify wait warn wrap write use be let provide translate track render draw organise organize structure design ' +
  'implement refactor reduce increase simplify focus work adopt cover assert expect throw catch emit expose hide ' +
  'guard protect sanitise sanitize normalise normalize parse convert round pad truncate capitalise capitalize ' +
  'comment highlight reference';

const IMPERATIVE_SK =
  'daj dodržuj doplň drž hľadaj hovor kontroluj maž meň nahraď nájdi napíš navrhni nechaj obnov odpovedaj odstráň ' +
  'opakuj oprav opýtaj otestuj otvor over označ píš počkaj pomenuj porovnaj pošli použi používaj povedz pozri ' +
  'preferuj prečítaj premenuj presuň pridaj priprav pýtaj rob skontroluj skús spočítaj sprav spusti spúšťaj ulož ' +
  'uprav uprednostni uveď vlož vráť vyber vyhni vyhýbaj vymaž vypíš vytvor začni zachovaj zapíš zapisuj zavri ' +
  'zhrň zisti zmaž zmeň zostav zoraď zverejni';

const IMPERATIVES = new Set([...IMPERATIVE_EN.split(' '), ...IMPERATIVE_SK.split(' ')]);
const SLOVAK_IMPERATIVES = new Set(IMPERATIVE_SK.split(' '));

// Words that make a sentence a rule whatever its first word is.
const MODAL = [
  /\b(must|never|always|do not|don't|dont)\b/i,
  /(?<![\p{L}])(nikdy|vždy|nesmie\p{L}*|nesmú|musí\p{L}*|musia)(?![\p{L}])/iu,
];

const stripLead = (text) =>
  text
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\[[ xX]\]\s+/, '')
    .replace(/^[*_"'“„(]+/, '');

// The first word, lower case, without what clings to it.
function firstWord(text) {
  const match = /^[\p{L}'’-]+/u.exec(text);
  return match ? match[0].toLowerCase().replace(/[’']/g, "'") : '';
}

function opensWithImperative(text) {
  const word = firstWord(text);
  if (IMPERATIVES.has(word)) return true;
  // Slovak forbids with a prefix: "nemeň", "nepoužívaj".
  return word.startsWith('ne') && SLOVAK_IMPERATIVES.has(word.slice(2));
}

// true when the sentence is written as an instruction: it opens with an imperative, or it holds
// must / never / always / do not (nikdy, vždy, nesmie, musí). "The export covers all customers
// except in one region" describes how software behaves and is not one.
export function isInstructionSentence(sentence) {
  const text = stripLead(sentence);
  return opensWithImperative(text) || MODAL.some((pattern) => pattern.test(text));
}

export function sentencesOf(text) {
  return stripLead(text)
    .split(/(?<=[.!?])\s+(?=[\p{Lu}"'`(])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}
