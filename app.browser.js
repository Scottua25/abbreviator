const STOP_WORDS = new Set(['A','AN','AND','ARE','AS','AT','BY','FOR','FROM','IN','INTO','OF','ON','OR','THE','TO','WITH','WITHOUT','NO','NOT','NEW','OLD']);

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\u00A0/g, ' ')
    .replace(/&/g, ' AND ')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function tokensFor(value) {
  const norm = normalizeText(value);
  return norm ? norm.split(' ').filter(t => t && !STOP_WORDS.has(t)) : [];
}

function unique(arr) { return [...new Set(arr.filter(Boolean))]; }

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function sourcePriority(source) {
  const s = String(source || '').toUpperCase();
  if (s.includes('WM') || s.includes('PK')) return 0;
  if (s.includes('ASME')) return 1;
  return 2;
}

function prepareAbbreviations(records) {
  const bestByTerm = new Map();
  for (const rec of records || []) {
    const term = normalizeText(rec.term);
    const abbreviation = String(rec.abbreviation || '').trim().toUpperCase();
    if (!term || !abbreviation) continue;
    const candidate = { term, abbreviation, source: rec.source || rec.remarks || '' };
    const existing = bestByTerm.get(term);
    if (!existing || sourcePriority(candidate.source) < sourcePriority(existing.source)) {
      bestByTerm.set(term, candidate);
    }
  }
  return [...bestByTerm.values()].sort((a, b) => {
    const ap = sourcePriority(a.source), bp = sourcePriority(b.source);
    const aw = a.term.split(' ').length, bw = b.term.split(' ').length;
    return ap - bp || bw - aw || b.term.length - a.term.length || a.term.localeCompare(b.term);
  });
}

function buildShortDescription(longText, abbreviations, maxLen = 30) {
  maxLen = 30;
  const extracted = extractDimensions(longText);
  const dimensionText = extracted.dims.map(d => d.replace(/\s*x\s*/gi, 'X')).join(' ');
  const originalTokens = tokensFor(extracted.without);
  let dateCode = '';
  if (originalTokens.length && /^\d{4}$/.test(originalTokens[originalTokens.length - 1])) dateCode = originalTokens.pop();

  let base = ` ${originalTokens.join(' ')} `;
  const matches = [];
  for (const rec of prepareAbbreviations(abbreviations)) {
    const pattern = new RegExp(` ${escapeRegex(rec.term)} `, 'g');
    if (pattern.test(base)) {
      base = base.replace(pattern, ` ${rec.abbreviation} `);
      matches.push(rec);
    }
  }
  base = base.replace(/\s+/g, ' ').trim();
  const suffix = [dimensionText, dateCode].filter(Boolean).join(' ');
  let short = base;
  if (suffix) {
    const room = Math.max(0, maxLen - suffix.length - 1);
    short = `${base.slice(0, room).trimEnd()} ${suffix}`.trim();
  } else if (short.length > maxLen) {
    short = short.slice(0, maxLen).trimEnd();
  }
  if (short.length > maxLen) short = short.slice(0, maxLen).trimEnd();
  return {
    short,
    length: short.length,
    status: short.length <= maxLen ? 'OK' : 'REVIEW',
    matches,
    unmatched: originalTokens.filter(t => !matches.some(m => m.term.split(' ').includes(t)) && !/^\d+$/.test(t)),
  };
}

function haystackFor(record, fields) {
  return fields.map(f => record[f]).filter(Boolean).join(' ');
}

function extractDimensions(raw) {
  const text = String(raw || '');
  const dimRegex = /\b\d+(?:\.\d+)?(?:\s*[xX]\s*\d+(?:\.\d+)?){1,3}\b/g;
  const dims = [];
  const without = text.replace(dimRegex, m => {
    dims.push(m.replace(/\s*[xX]\s*/g, ' x '));
    return ' ';
  });
  return { without, dims };
}

function rankCandidates(description, records, fields = ['name', 'description'], limit = 5) {
  const queryNorm = normalizeText(description);
  const qTokens = tokensFor(description);
  if (!queryNorm || !qTokens.length) return [];
  const scored = [];
  for (const record of records || []) {
    const hayRaw = haystackFor(record, fields);
    const hayNorm = normalizeText(hayRaw);
    if (!hayNorm) continue;
    const hayTokens = tokensFor(hayRaw);
    const haySet = new Set(hayTokens);
    let score = 0;
    const reasons = [];
    const nameNorm = normalizeText(record.name || record.action || '');
    const nameTokens = tokensFor(record.name || record.action || '');
    const firstMeaningfulToken = qTokens[0];
    if (firstMeaningfulToken && nameTokens.includes(firstMeaningfulToken)) {
      score += 70;
      reasons.push(`matched leading noun/commodity: ${firstMeaningfulToken.toLowerCase()}`);
    }
    if (nameNorm && queryNorm.includes(nameNorm)) {
      const singleWordNonNoun = nameTokens.length === 1 && firstMeaningfulToken !== nameTokens[0];
      score += singleWordNonNoun ? 40 : 120;
      reasons.push(`contains exact candidate phrase: ${String(record.name || record.action).toLowerCase()}`);
    }
    if (nameNorm && nameNorm.includes(queryNorm)) { score += 80; reasons.push('candidate contains full input phrase'); }
    for (const t of qTokens) {
      if (haySet.has(t)) { score += 12; reasons.push(`matched word: ${t.toLowerCase()}`); }
      else if (hayTokens.some(h => h.startsWith(t) || t.startsWith(h))) { score += 5; }
    }
    for (let n = Math.min(4, qTokens.length); n >= 2; n--) {
      for (let i = 0; i <= qTokens.length - n; i++) {
        const phrase = qTokens.slice(i, i + n).join(' ');
        if (hayNorm.includes(phrase)) { score += n * 18; reasons.push(`matched phrase: ${phrase.toLowerCase()}`); }
      }
    }
    const abbrNorm = normalizeText(record.abbreviation || '');
    if (abbrNorm) {
      const abbrTokens = abbrNorm.split(' ');
      const wholeAbbrMatch = abbrTokens.length === 1 ? qTokens.includes(abbrNorm) : queryNorm.includes(abbrNorm);
      if (wholeAbbrMatch) { score += 30; reasons.push('matched abbreviation'); }
    }
    if (score > 0) scored.push({ ...record, score, reasons: unique(reasons).slice(0, 6) });
  }
  return scored.sort((a, b) => b.score - a.score || String(a.name || a.action).localeCompare(String(b.name || b.action))).slice(0, limit);
}

function boostLinked(primary, records, fieldName, targetValue, fields, limit) {
  const linked = [];
  const seen = new Set();
  for (const p of primary) {
    const target = p[targetValue];
    if (!target) continue;
    const targetNorm = normalizeText(target);
    const exact = (records || []).find(r => normalizeText(r[fieldName] || r.name || r.action) === targetNorm || normalizeText(r.name || r.action || '') === targetNorm)
      || (records || []).find(r => normalizeText(r[fieldName] || r.name || r.action).includes(targetNorm) || targetNorm.includes(normalizeText(r.name || r.action || '')));
    if (exact) {
      const key = exact.name || exact.action;
      if (!seen.has(key)) { linked.push({ ...exact, score: (p.score || 0) + 50, reasons: [`linked from component type: ${p.name}`] }); seen.add(key); }
    }
  }
  const merged = linked.concat(rankCandidates(primary.map(p => p.name).join(' '), records, fields, limit));
  const deduped = [];
  const finalSeen = new Set();
  for (const row of merged.sort((a,b)=>b.score-a.score)) {
    const key = normalizeText(row.name || row.action || '');
    if (!key || finalSeen.has(key)) continue;
    finalSeen.add(key);
    deduped.push(row);
  }
  return deduped.slice(0, limit);
}

const FIELD_CONFIG = {
  componentType: { dataKey: 'componentTypes', fields: ['name','abbreviation','partNumberPrefix','componentGroup','productGroup','description'] },
  componentGroup: { dataKey: 'componentGroups', fields: ['name','action','code','commodity','stockingType','lineType','itemType'] },
  productGroup: { dataKey: 'productGroups', fields: ['name','description','notes'] },
  productType: { dataKey: 'productTypes', fields: ['name','productCategory','parentProductGroup','description','abbreviation'] },
};

function browseFieldOptions(data, fieldName, searchText = '', limit = 1000) {
  const cfg = FIELD_CONFIG[fieldName];
  if (!cfg) throw new Error(`Unknown field list: ${fieldName}`);
  const rows = data[cfg.dataKey] || [];
  const query = normalizeText(searchText);
  if (!query) {
    return [...rows]
      .sort((a, b) => String(a.name || a.action).localeCompare(String(b.name || b.action)))
      .slice(0, limit)
      .map(r => ({ ...r, browseOnly: true, fieldName }));
  }
  return rankCandidates(searchText, rows, cfg.fields, limit)
    .map(r => ({ ...r, browseOnly: true, fieldName }));
}

function browsableProductTypes(description, data, componentType, productGroup, limit) {
  const strong = rankCandidates(description, data.productTypes, ['name','productCategory','parentProductGroup','description','abbreviation'], limit)
    .filter(row => row.score >= 40);
  if (strong.length) return strong;

  const context = normalizeText([
    description,
    ...componentType.slice(0, 3).map(r => `${r.name} ${r.componentGroup} ${r.productGroup}`),
    ...productGroup.slice(0, 2).map(r => r.name),
  ].join(' '));

  const browse = [];
  for (const row of data.productTypes || []) {
    const name = normalizeText(row.name);
    const parent = normalizeText(row.parentProductGroup);
    let score = 1;
    const reasons = ['browse fallback: no obvious product type matched the item description'];

    // For component-level Parts with boiler/blower/control/wiring context, surface the
    // generic boiler accessory bucket as a browsable candidate instead of pretending
    // the item is itself a blower/boiler.
    if (name.includes('BOILER ACCESSOR')) {
      score += 80;
      reasons.push('generic boiler accessory option for component-level parts');
    }
    if (parent.includes('BOILER')) score += 12;
    if (context.includes('BLOWER') && name.includes('BOILER')) score += 8;
    if ((context.includes('HARNESS') || context.includes('WIRE') || context.includes('JUMPER')) && name.includes('ACCESSOR')) score += 8;
    if (score > 1) browse.push({ ...row, score, browseOnly: true, reasons });
  }
  return browse.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name))).slice(0, limit);
}

function suggestFields(description, data, limit = 5) {
  if (!tokensFor(description).length) {
    return { componentType: [], componentGroup: [], productGroup: [], productType: [] };
  }
  const componentType = rankCandidates(description, data.componentTypes, ['name','abbreviation','componentGroup','productGroup','description'], limit);
  const componentGroup = boostLinked(componentType, data.componentGroups, 'action', 'componentGroup', ['name','action','code'], limit);
  const productGroup = boostLinked(componentType, data.productGroups, 'name', 'productGroup', ['name','description','notes'], limit);
  const productType = browsableProductTypes(description, data, componentType, productGroup, limit);
  return { componentType, componentGroup, productGroup, productType };
}

async function loadData(url = './data/eco-reference-data.json') {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (response.ok) return response.json();
  } catch {
    // Opening index.html directly from a file share blocks fetch() in browsers.
    // Fall back to the generated JS module so the tool still works locally.
  }
  try {
    const module = await import('./data/eco-reference-data.js');
    return module.default;
  } catch (err) {
    throw new Error(`Could not load ECO reference data: ${err.message}`);
  }
}

function wireUi(data) {
  const input = document.getElementById('longText');
  const shortOut = document.getElementById('shortOut');
  const meta = document.getElementById('meta');
  const matches = document.getElementById('matches');
  const fields = document.getElementById('fields');
  function render() {
    const result = buildShortDescription(input.value, data.abbreviations, 30);
    const suggestions = suggestFields(input.value, data, 5);
    shortOut.textContent = result.short || '—';
    meta.textContent = `Length: ${result.length} / 30 • Status: ${result.status} • Rule: WM/PK first, ASME fallback`;
    matches.innerHTML = result.matches.length ? result.matches.map(m => `<li><b>${m.term}</b> → <code>${m.abbreviation}</code> <span>${m.source || ''}</span></li>`).join('') : '<li>No abbreviation matches yet.</li>';
    fields.innerHTML = ['componentType','componentGroup','productGroup','productType'].map(k => renderGroup(k, suggestions[k])).join('');
    setupBrowseInputs(data);
  }
  document.getElementById('convertBtn').addEventListener('click', render);
  input.addEventListener('input', render);
  document.getElementById('copyBtn').addEventListener('click', async () => navigator.clipboard.writeText(shortOut.textContent || ''));
  render();
}

function setupBrowseInputs(data) {
  document.querySelectorAll('[data-browse-input]').forEach(el => {
    const fieldName = el.dataset.browseInput;
    const outEl = document.querySelector(`[data-browse-output="${fieldName}"]`);
    const renderBrowse = () => {
      const rows = browseFieldOptions(data, fieldName, el.value, 80);
      outEl.innerHTML = rows.length ? rows.map(renderBrowseRow).join('') : '<li>—</li>';
    };
    el.addEventListener('input', renderBrowse);
    renderBrowse();
  });
}

function displayValueForField(fieldName, row) {
  if (!row) return '';
  if (fieldName === 'componentGroup') return row.action || row.name || '';
  return row.name || row.action || '';
}

function renderBrowseRow(r) {
  return `<li>${displayValueForField(r.fieldName, r)}</li>`;
}

function renderGroup(label, rows) {
  const title = label.replace(/[A-Z]/g, m => ' ' + m).replace(/^./, m => m.toUpperCase());
  const placeholder = `Search ${title.toLowerCase()} options…`;
  const body = rows.length ? rows.map(r => `<li class="${r.browseOnly ? 'browse' : ''}"><b>${displayValueForField(label, r)}</b> <span class="score">${r.browseOnly ? 'browse' : Math.round(r.score)}</span></li>`).join('') : '<li>—</li>';
  return `<section><div class="field-head"><h3>${title}</h3><details class="field-browse"><summary>Browse list</summary><input data-browse-input="${label}" placeholder="${placeholder}"><ol data-browse-output="${label}"></ol></details></div><ol>${body}</ol></section>`;
}
