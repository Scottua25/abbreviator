import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildShortDescription,
  rankCandidates,
  suggestFields,
  normalizeText,
  browseFieldOptions,
  displayValueForField,
} from '../app.js';

const sampleData = {
  abbreviations: [
    { term: 'GAS VALVE', abbreviation: 'VLV-G', source: 'WM/PK' },
    { term: 'VALVE', abbreviation: 'VLV', source: 'WM/PK' },
    { term: 'NATURAL', abbreviation: 'NAT', source: 'WM/PK' },
    { term: 'CAST IRON', abbreviation: 'CI', source: 'WM/PK' },
    { term: 'ADAPTER', abbreviation: 'ADPTR', source: 'ASME Y14.38' },
    { term: 'PRESSURE', abbreviation: 'PRESS', source: 'ASME Y14.38' },
  ],
  componentTypes: [
    { name: 'Gas Valve', abbreviation: 'Vlv-G', partNumberPrefix: '5110', componentGroup: 'Valves', productGroup: 'Parts', description: '' },
    { name: 'Gasket', abbreviation: 'Gskt', partNumberPrefix: '5903', componentGroup: 'Gaskets', productGroup: 'Parts', description: 'Gasket' },
    { name: 'Adapter', abbreviation: 'Adpt', partNumberPrefix: '5623', componentGroup: 'Adapters', productGroup: 'Hardware', description: 'Adapter - Pilot, Dresser, Hose Barb' },
    { name: 'Blower', abbreviation: 'Blw', partNumberPrefix: '', componentGroup: 'Blowers', productGroup: 'Parts', description: '' },
    { name: 'Wire Harness', abbreviation: 'Hrns-Wrng', partNumberPrefix: '', componentGroup: 'Wire Harnesses', productGroup: 'Parts', description: '' },
    { name: 'Bracket', abbreviation: 'Bkt', partNumberPrefix: '4600', componentGroup: 'Brackets, Shutters, and Plates', productGroup: 'Fabricated Parts', description: '' },
  ],
  componentGroups: [
    { name: '69 - VALVES-GAS', action: 'Valves', code: '69' },
    { name: '107 - GASKETS', action: 'Gaskets', code: '107' },
    { name: '91 - HARDWARE-OTHER', action: 'Fittings', code: '91' },
    { name: 'Wire Harnesses', action: 'Wire Harnesses', code: '' },
  ],
  productGroups: [
    { name: 'Parts', description: '' },
    { name: 'Hardware', description: '' },
  ],
  productTypes: [
    { name: 'Gas Boiler', productCategory: 'Boilers', parentProductGroup: 'Boilers', abbreviation: '' },
    { name: 'Boiler Accessories', productCategory: '', parentProductGroup: 'Boilers', abbreviation: '' },
    { name: 'Baseboard Accessory', productCategory: 'Baseboard Heaters', parentProductGroup: 'Heaters', abbreviation: '' },
    { name: 'Kit Service', productCategory: 'Kits', parentProductGroup: 'Kits', abbreviation: 'Kit-S' },
  ],
};

test('normalizeText keeps searchable words and uppercases them', () => {
  assert.equal(normalizeText('Gas valve, natural/LP (1 in.)'), 'GAS VALVE NATURAL LP 1 IN');
});

test('buildShortDescription prefers WM/PK phrase matches before ASME fallback', () => {
  const result = buildShortDescription('Natural gas valve adapter', sampleData.abbreviations, 30);
  assert.equal(result.short, 'NAT VLV-G ADPTR');
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.matches.map(m => [m.term, m.abbreviation, m.source]), [
    ['GAS VALVE', 'VLV-G', 'WM/PK'],
    ['NATURAL', 'NAT', 'WM/PK'],
    ['ADAPTER', 'ADPTR', 'ASME Y14.38'],
  ]);
});

test('buildShortDescription enforces the 30 character hard rule even if a different max is passed', () => {
  const result = buildShortDescription('Cast iron pressure adapter with extra words 0826', sampleData.abbreviations, 80);
  assert.equal(result.length <= 30, true);
});

test('buildShortDescription preserves trailing 4 digit date code inside the 30 character hard limit', () => {
  const result = buildShortDescription('Cast iron pressure adapter 0826', sampleData.abbreviations, 16);
  assert.equal(result.short.endsWith('0826'), true);
  assert.equal(result.short.length <= 30, true);
});

test('buildShortDescription preserves decimal dimensions compactly when abbreviating', () => {
  const result = buildShortDescription('Bracket Support Control Panel 17.81 x 14.25 x 8.00', sampleData.abbreviations, 30);
  assert.equal(result.short.includes('17.81X'), true);
  assert.equal(result.short.length <= 30, true);
});

test('rankCandidates returns likely exact-ish candidates with scores and reasons', () => {
  const ranked = rankCandidates('Natural gas valve 1 inch', sampleData.componentTypes, ['name', 'description', 'componentGroup'], 3);
  assert.equal(ranked[0].name, 'Gas Valve');
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked[0].reasons.some(r => r.includes('gas')));
});

test('suggestFields returns no candidate rows before description input is provided', () => {
  const suggestions = suggestFields('', sampleData, 3);
  assert.deepEqual(Object.fromEntries(Object.entries(suggestions).map(([k, v]) => [k, v.length])), {
    componentType: 0,
    componentGroup: 0,
    productGroup: 0,
    productType: 0,
  });
});

test('suggestFields uses component type as primary bridge into group fields', () => {
  const suggestions = suggestFields('Natural gas valve 1 inch', sampleData, 3);
  assert.equal(suggestions.componentType[0].name, 'Gas Valve');
  assert.equal(suggestions.componentGroup[0].name, '69 - VALVES-GAS');
  assert.equal(suggestions.productGroup[0].name, 'Parts');
});

test('suggestFields treats the first noun as the item identity for noun modifier descriptions', () => {
  const suggestions = suggestFields('Harness Blower Jumper', sampleData, 3);
  assert.equal(suggestions.componentType[0].name, 'Wire Harness');
  assert.equal(suggestions.componentGroup[0].name, 'Wire Harnesses');
  assert.equal(suggestions.productGroup[0].name, 'Parts');
});

test('suggestFields exposes browsable product type fallbacks when no obvious product type surfaces', () => {
  const suggestions = suggestFields('Harness Blower Jumper', sampleData, 3);
  assert.equal(suggestions.productType[0].name, 'Boiler Accessories');
  assert.equal(suggestions.productType[0].browseOnly, true);
  assert.ok(suggestions.productType[0].reasons.some(r => r.includes('browse')));
});

test('browseFieldOptions returns all options for a field sorted by name', () => {
  const rows = browseFieldOptions(sampleData, 'productType', '', 10);
  assert.deepEqual(rows.map(r => r.name), ['Baseboard Accessory', 'Boiler Accessories', 'Gas Boiler', 'Kit Service']);
});

test('browseFieldOptions filters options by fuzzy search text', () => {
  const rows = browseFieldOptions(sampleData, 'productType', 'boiler acc', 10);
  assert.equal(rows[0].name, 'Boiler Accessories');
  assert.ok(rows[0].score > 0);
});

test('displayValueForField shows only the value that should be entered for that field', () => {
  assert.equal(displayValueForField('componentType', sampleData.componentTypes[4]), 'Wire Harness');
  assert.equal(displayValueForField('componentGroup', sampleData.componentGroups[3]), 'Wire Harnesses');
  assert.equal(displayValueForField('productGroup', sampleData.productGroups[0]), 'Parts');
  assert.equal(displayValueForField('productType', sampleData.productTypes[1]), 'Boiler Accessories');
});
