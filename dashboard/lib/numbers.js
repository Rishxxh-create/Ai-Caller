// lib/numbers.js
// Convert Arabic numerals in text to English words so the voice always reads
// numbers in English, even when the TTS language is Hindi or Hinglish. Applied
// at the TTS boundary (batch route and the browser streaming path) and backed
// by a prompt directive for the Dograh live-call path. Zero dependencies.

const NUM_SMALL = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const NUM_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORDINAL_WORD = {
  one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth',
  nine: 'ninth', twelve: 'twelfth', twenty: 'twentieth', thirty: 'thirtieth',
  forty: 'fortieth', fifty: 'fiftieth', sixty: 'sixtieth', seventy: 'seventieth',
  eighty: 'eightieth', ninety: 'ninetieth', hundred: 'hundredth', crore: 'croreth',
  lakh: 'lakth', thousand: 'thousandth',
};

function numUnder100(n) {
  if (n < 20) return NUM_SMALL[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return NUM_TENS[tens] + (ones ? ' ' + NUM_SMALL[ones] : '');
}

function numUnder1000(n) {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (!hundreds) return numUnder100(rest);
  return NUM_SMALL[hundreds] + ' hundred' + (rest ? ' and ' + numUnder100(rest) : '');
}

// Indian numbering system: crore, lakh, thousand.
function integerToEnglish(n) {
  if (!Number.isFinite(n)) return '';
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'zero';
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;
  const parts = [];
  if (crore) parts.push(integerToEnglish(crore) + ' crore');
  if (lakh) parts.push(integerToEnglish(lakh) + ' lakh');
  if (thousand) parts.push(integerToEnglish(thousand) + ' thousand');
  if (rest) parts.push(numUnder1000(rest));
  return parts.join(' ');
}

function ordinalWord(word) {
  return ORDINAL_WORD[word] || word + 'th';
}

function makeOrdinal(n) {
  if (n === 0) return 'zeroth';
  const words = integerToEnglish(n).split(' ');
  words[words.length - 1] = ordinalWord(words[words.length - 1]);
  return words.join(' ');
}

// A phone-style number: every digit spoken on its own in English.
function digitsToEnglish(digits) {
  const out = [];
  for (const ch of digits) {
    if (ch === '.') out.push('point');
    else if (ch >= '0' && ch <= '9') out.push(NUM_SMALL[+ch]);
  }
  return out.join(' ');
}

function convertNumberToken(raw, isCurrency) {
  const clean = String(raw).replace(/,/g, '');
  const dot = clean.indexOf('.');
  let words;
  if (dot !== -1) {
    const intPart = clean.slice(0, dot) || '0';
    const fracPart = clean.slice(dot + 1);
    words = integerToEnglish(parseInt(intPart, 10) || 0);
    if (fracPart && /\d/.test(fracPart)) {
      words += ' point ' + digitsToEnglish(fracPart);
    }
  } else {
    const digits = clean.replace(/\D/g, '');
    if (digits.length >= 7) words = digitsToEnglish(digits);
    else words = integerToEnglish(parseInt(digits, 10) || 0);
  }
  return isCurrency ? words + ' rupees' : words;
}

// Rewrite numerals in the text as English words. Long runs (7+ digits) are read
// digit by digit like phone numbers; shorter numbers use Indian scale words.
// Decimal parts are read digit by digit after "point". Ordinals ("21st") and
// percentages ("25%") and rupee amounts ("Rs 499") are handled as well.
function numbersToEnglishWords(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(/(?:₹|(?<![A-Za-z])Rs\.?|(?<![A-Za-z])INR)\s*(\d[\d,]*(?:\.\d+)?)/g,
    (match, num) => convertNumberToken(num, true));
  s = s.replace(/(?<![A-Za-z0-9_])(\d[\d,]*(?:\.\d+)?)(st|nd|rd|th)?\s?%?(?![A-Za-z0-9_])/g,
    (match, num, ord) => {
      const clean = num.replace(/,/g, '');
      if (ord) return makeOrdinal(parseInt(clean, 10) || 0);
      const tail = match.endsWith('%') ? ' percent' : '';
      return convertNumberToken(num, false) + tail;
    });
  return s;
}

module.exports = { numbersToEnglishWords, integerToEnglish, makeOrdinal };
