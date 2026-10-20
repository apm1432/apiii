// run: node tests/subjects.test.js   (no database needed)
const assert = require('assert');
const { buildResolver, subjKey, splitBilingual, suggest } = require('../utils/subjects');

// the real list from the student's screenshots
const raw = {
  'Economics': 11, 'Economics (अर्थशास्त्र)': 21, 'अर्थशास्त्र': 7, 'अर्थशास्त्र (Economics)': 2,
  'Polity': 3, 'Polity (राज्यशास्त्र)': 17, 'Indian Polity': 7, 'भारतीय राज्यघटना': 1,
  'Geography': 17, 'Geography (भूगोल)': 18, 'भूगोल': 1,
  'History': 15, 'History (इतिहास)': 13, 'इतिहास': 2,
  'Current Affairs': 8, 'Current Affairs (चालू घडामोडी)': 16, 'चालू घडामोडी': 1,
  'General Science': 3, 'General Science (सामान्य विज्ञान)': 19, 'विज्ञान': 2,
  'Math & Reasoning (गणित व बुद्धिमत्ता)': 18, 'गणित व बुद्धिमत्ता': 2, 'Mathematics': 1,
  'चालू घडामोडी / क्रीडा': 1, 'null': 2, '': 1
};
let r = buildResolver(raw, []);
const same = (a, b) => assert.strictEqual(r.canon(a), r.canon(b), `${a} should equal ${b}`);
const diff = (a, b) => assert.notStrictEqual(r.canon(a), r.canon(b), `${a} must stay different from ${b}`);

// rule 1 + 2
['Economics', 'Economics (अर्थशास्त्र)', 'अर्थशास्त्र', 'अर्थशास्त्र (Economics)', ' economics ', 'ECONOMICS.'].forEach(x => same(x, 'Economics'));
same('Polity', 'Polity (राज्यशास्त्र)'); same('Geography', 'भूगोल'); same('History', 'इतिहास'); same('Current Affairs', 'चालू घडामोडी');
same('General Science', 'सामान्य विज्ञान'); same('Math & Reasoning (गणित व बुद्धिमत्ता)', 'गणित व बुद्धिमत्ता'); same('Math and Reasoning (गणित व बुद्धिमत्ता)', 'गणित व बुद्धिमत्ता');
assert.strictEqual(r.canon('Economics'), 'Economics (अर्थशास्त्र)', 'most used spelling is the shown name');
// things the rules must NOT guess
diff('Polity', 'Indian Polity'); diff('Mathematics', 'Math & Reasoning (गणित व बुद्धिमत्ता)'); diff('चालू घडामोडी / क्रीडा', 'Current Affairs'); diff('Economics', 'Geography'); diff('General Science', 'विज्ञान');   // 'विज्ञान' is not the bracket pair, so the admin decides
assert.strictEqual(r.canon(null), 'Unclassified'); assert.strictEqual(r.canon('null'), 'Unclassified'); assert.strictEqual(r.canon(''), 'Unclassified');
// a spelling that did not exist when the table was built still lands in the right subject
same('Geography  (भूगोल) ', 'Geography'); assert.strictEqual(r.canon('Polity (राज्यशास्त्र) '), r.canon('Polity'));
assert.strictEqual(r.canon('Totally New Subject'), 'Totally New Subject');
// bracket that is NOT a translation does not merge
assert.strictEqual(splitBilingual('History (Ancient)'), null);
const r2 = buildResolver({ 'History': 10, 'History (Ancient)': 4 }, []); assert.notStrictEqual(r2.canon('History'), r2.canon('History (Ancient)'));

// rawsOf = every stored spelling (used to query the database)
assert.deepStrictEqual(r.rawsOf(r.canon('Economics')).sort(), ['Economics', 'Economics (अर्थशास्त्र)', 'अर्थशास्त्र', 'अर्थशास्त्र (Economics)'].sort());

// rule 3: admin merge + admin chosen name
const v1 = r.version;
r = buildResolver(raw, [{ from: 'Indian Polity', to: 'Polity (राज्यशास्त्र)', createdAt: new Date() }, { from: 'भारतीय राज्यघटना', to: 'Polity (राज्यशास्त्र)', createdAt: new Date() }]);
same('Indian Polity', 'Polity'); same('भारतीय राज्यघटना', 'Polity'); assert.strictEqual(r.canon('Indian Polity'), 'Polity (राज्यशास्त्र)'); assert.notStrictEqual(r.version, v1);
r = buildResolver(raw, [{ from: 'Mathematics', to: 'Maths', createdAt: new Date(1) }, { from: 'Math & Reasoning (गणित व बुद्धिमत्ता)', to: 'Maths', createdAt: new Date(2) }]);
assert.strictEqual(r.canon('Mathematics'), 'Maths'); assert.strictEqual(r.canon('गणित व बुद्धिमत्ता'), 'Maths');
// the admin screen data
const L = r.list(); const econ = L.find(g => g.name === 'Economics (अर्थशास्त्र)');
assert.strictEqual(econ.total, 41); assert.strictEqual(econ.variants.length, 4); assert(econ.variants.every(x => x.via === 'auto'));
const mv = L.find(g => g.name === 'Maths').variants; assert.strictEqual(mv.filter(x => x.via === 'admin').length, 2); assert.strictEqual(mv.find(x => x.stored === 'गणित व बुद्धिमत्ता').via, 'auto');
// suggestions are hints for what the rules could not join
const s = suggest(buildResolver(raw, []).list()); assert(s.some(x => [x.a, x.b].some(n => /Polity/.test(n)) && [x.a, x.b].includes('Indian Polity')), JSON.stringify(s.slice(0, 5)));
assert(s.some(x => [x.a, x.b].some(n => /General Science/.test(n)) && [x.a, x.b].includes('विज्ञान')), 'the missing link is suggested');
assert.strictEqual(subjKey('  Polity.  '), 'polity'); assert.strictEqual(subjKey('A  &  B'), 'a and b');
console.log('subjects tests passed');
