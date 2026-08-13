'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { numbersToEnglishWords, integerToEnglish } = require('../lib/numbers');

test('integerToEnglish uses the Indian numbering system', () => {
  assert.equal(integerToEnglish(0), 'zero');
  assert.equal(integerToEnglish(7), 'seven');
  assert.equal(integerToEnglish(25), 'twenty five');
  assert.equal(integerToEnglish(499), 'four hundred and ninety nine');
  assert.equal(integerToEnglish(123456), 'one lakh twenty three thousand four hundred and fifty six');
  assert.equal(integerToEnglish(100000000), 'ten crore');
});

test('plain numerals become English words', () => {
  assert.equal(numbersToEnglishWords('your bill is 499'), 'your bill is four hundred and ninety nine');
  assert.equal(numbersToEnglishWords('Call at 5:30'), 'Call at five:thirty');
  assert.equal(numbersToEnglishWords('Booked for 2024'), 'Booked for two thousand twenty four');
});

test('phone-style numbers read digit by digit', () => {
  assert.equal(numbersToEnglishWords('dial 9876543210'), 'dial nine eight seven six five four three two one zero');
  assert.equal(numbersToEnglishWords('number 919484956633'), 'number nine one nine four eight four nine five six six three three');
});

test('decimals read with point', () => {
  assert.equal(numbersToEnglishWords('balance is 3.5'), 'balance is three point five');
  assert.equal(numbersToEnglishWords('price 12.05'), 'price twelve point zero five');
});

test('ordinals and percentages', () => {
  assert.equal(numbersToEnglishWords('the 1st call'), 'the first call');
  assert.equal(numbersToEnglishWords('on the 21st of March'), 'on the twenty first of March');
  assert.equal(numbersToEnglishWords('25% off'), 'twenty five percent off');
});

test('rupee amounts become words plus rupees', () => {
  assert.equal(numbersToEnglishWords('costs Rs 499'), 'costs four hundred and ninety nine rupees');
  assert.equal(numbersToEnglishWords('pay 500'), 'pay five hundred');
});

test('leaves words and mixed tokens alone', () => {
  assert.equal(numbersToEnglishWords('A2Z courier'), 'A2Z courier');
  assert.equal(numbersToEnglishWords('version 3 of the app'), 'version three of the app');
  assert.equal(numbersToEnglishWords(''), '');
  assert.equal(numbersToEnglishWords(null), '');
});
