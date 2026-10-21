// The view model: everything a screen or a report shows, built once from a scan and its checks
// (and, after the changes, from the earlier checks and the record of what was applied).
// The console and both HTML reports render from this object and from nothing else, so their
// numbers cannot disagree. Every text in it is already in the language asked for.
//
// It reads one kind of file: the SKILL.md files the scan lists, to draw the steps of each skill.
// A linked skill folder is never read.

import { readFileSync } from 'node:fs';
import { FLOW_LIMITS, extractFlow, mergeBranches, toMermaid } from './flow.mjs';
import { MEMORY_KINDS, SEVERITIES } from './kinds.mjs';
import { byFile } from './order.mjs';
import { displayPath, join } from './paths.mjs';
import { STRINGS, assertLang, t } from './strings.mjs';
import { formatNumber, visible } from './term.mjs';

// Checks whose finding belongs to one skill; each has a short note for the list of skills.
export const SKILL_NOTE_CHECKS = [
  'skill-too-long',
  'skill-no-description',
  'skill-no-when-cue',
  'skill-description-too-long',
  'skill-name-mismatch',
  'skill-unreachable',
  'front-matter-unreadable',
];

const percent = (value, limit) => (limit ? Math.round((value / limit) * 100) : null);

// Every text of a view made printable by the one function that does that (lib/term.mjs, visible).
// A view is cleaned as a whole before it leaves buildView, so no screen and no report has to
// remember which of its strings came from a scanned file. Two kinds of text are blocks of lines
// that this tool joined itself, the quote of a finding and the text of a diagram; they keep the
// breaks between their lines. Every other text is one line, whatever a file put into it.
const BLOCKS = new Set(['quote', 'mermaid']);
function clean(value, key = null) {
  if (typeof value === 'string') return visible(value, { breaks: BLOCKS.has(key) });
  if (Array.isArray(value)) return value.map((entry) => clean(entry, key));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, clean(entry, name)]));
  return value;
}
const stateOf = (value, limit) => (limit === null ? null : value > limit ? 'over' : value > limit * 0.8 ? 'near' : 'ok');

// What a file-by-file list says about one file before it lists what is in it: its name, what
// kind of file it is, and its lines against the recommendation where there is one. `group` is
// one entry of byFile() in lib/order.mjs. The walk of cards uses this for the header it prints
// when it enters a file, so the header and the reports say the same.
export function fileFacts({ scan, checks, lang }) {
  const projects = (scan.projects ?? []).map((project) => project.path);
  const limits = checks.limits;
  return (group) => {
    const limit = group.lines === null ? null : MEMORY_KINDS.includes(group.kind) && group.kind !== 'import' ? limits.memoryFileLines.value : group.kind === 'skill' ? limits.skillLines.value : null;
    return {
      path: group.path,
      label: displayPath(group.path, scan.home, projects),
      kind: group.kind,
      kindLabel: t(lang, `kind.${group.kind}`),
      scope: group.scope,
      project: group.project,
      lines: group.lines,
      limit,
      percent: percent(group.lines, limit),
      state: stateOf(group.lines, limit),
    };
  };
}

// flows: { [path of a SKILL.md]: branches a reader found in its prose }, each with the exact
// quote of its line; a branch whose quote does not match is left out by the flow module.
export function buildView({ scan, checks, before = null, applied = null, flows = null, lang = checks.lang, now = new Date() }) {
  assertLang(lang);
  const tr = (key, params) => t(lang, key, params);
  const home = scan.home;
  const projects = scan.projects ?? [];
  const projectPaths = projects.map((project) => project.path);
  const label = (file) => displayPath(file, home, projectPaths);
  const byPath = new Map(scan.files.map((file) => [file.path, file]));
  const limits = checks.limits;
  const whereOf = (item) => (item.line === null || item.line === undefined ? label(item.file) : `${label(item.file)}:${item.line}`);
  const placeLabel = (project, name) => (project === null ? tr('scope.user-only') : tr('place.in', { project: name }));
  // carried: a documented number that was not among the answers read on the date the report
  // names (lib/facts.mjs, verified: false). It is shown as carried over, never as read on that date.
  const carried = (limit) => limit.documented && limit.verified === false;
  const limitOf = (key) => ({ value: limits[key].value, documented: limits[key].documented, carried: carried(limits[key]), source: limits[key].source });
  const fmt = (number) => formatNumber(number, lang);
  const flowLabels = {
    start: tr('flow.start'),
    end: tr('flow.end'),
    yes: tr('flow.yes'),
    no: tr('flow.no'),
    // The count is filled in by the flow module, so the placeholder is handed over as it is.
    more: STRINGS[lang]['flow.more'],
  };

  // --- findings, candidates, review ---------------------------------------------------------

  const findingView = (finding, statusOf = null) => ({
    id: finding.id,
    check: finding.check,
    title: finding.check === 'judgement' ? finding.title : tr(`check.${finding.check}.title`),
    severity: finding.severity,
    severityLabel: tr(`severity.${finding.severity}`),
    file: finding.file,
    label: label(finding.file),
    line: finding.line,
    endLine: finding.endLine,
    where: whereOf(finding),
    quote: finding.quote,
    message: finding.message,
    why: finding.why,
    suggestion: { kind: finding.suggestion.kind, label: tr(`suggestion.${finding.suggestion.kind}`), detail: finding.suggestion.detail },
    related: (finding.related ?? []).filter((item) => item.quote !== null).map((item) => ({ where: whereOf(item), quote: item.quote })),
    error: finding.data?.error ?? null,
    data: finding.data ?? null,
    status: statusOf ? statusOf(finding) : null,
  });

  function groupFindings(findings, statusOf) {
    return SEVERITIES.map((severity) => {
      const groups = [];
      for (const finding of findings.filter((item) => item.severity === severity)) {
        const view = findingView(finding, statusOf);
        // Findings from reading the files are grouped by the title their reader gave them.
        const key = finding.check === 'judgement' ? `judgement:${finding.title}` : finding.check;
        let group = groups.find((item) => item.key === key);
        if (!group) groups.push((group = { key, check: finding.check, title: view.title, count: 0, items: [] }));
        group.items.push(view);
        group.count += 1;
      }
      return { severity, label: tr(`severity.${severity}`), count: groups.reduce((sum, group) => sum + group.count, 0), groups };
    });
  }

  const candidateList = checks.candidates ?? [];
  const candidateGroups = [];
  for (const candidate of candidateList) {
    let group = candidateGroups.find((item) => item.check === candidate.check);
    if (!group) candidateGroups.push((group = { check: candidate.check, title: tr(`candidate.${candidate.check}.title`), count: 0, items: [] }));
    group.count += 1;
    group.items.push({
      id: candidate.id,
      check: candidate.check,
      where: whereOf(candidate),
      label: label(candidate.file),
      line: candidate.line,
      endLine: candidate.endLine,
      quote: candidate.quote,
      message: candidate.message,
      why: candidate.why,
      related: (candidate.related ?? []).filter((item) => item.quote !== null).map((item) => ({ where: whereOf(item), quote: item.quote })),
      command: candidate.data?.command ?? null,
      status: candidate.status,
      statusLabel: tr(`candidate.status.${candidate.status}`),
      reason: candidate.reason ?? null,
      finding: candidate.finding ?? null,
    });
  }
  const candidateCounts = checks.metrics.candidates ?? { total: 0, open: 0, confirmed: 0, dismissed: 0 };
  const pairs = { found: 0, compared: 0, confirmed: 0, leftOut: 0, ...checks.metrics.conflictPairs };
  // Pairs over the bound of the list are counted, not listed; the one sentence says how many.
  const leftOut = pairs.leftOut
    ? ` ${tr('candidates.leftOut', { count: fmt(pairs.leftOut), perLine: limits.conflictPairsPerLine.value, perPlace: limits.conflictPairsPerPlace.value })}`
    : '';
  const read = candidateCounts.confirmed + candidateCounts.dismissed;

  const review = (checks.review ?? []).map((item) => ({
    id: item.id,
    check: item.check,
    title: tr(`review.${item.check}.title`),
    where: label(item.file),
    project: item.project,
    projectLabel: label(item.project),
    servers: item.servers,
    message: item.message,
    why: item.why,
  }));

  // --- what loads, and what it costs ----------------------------------------------------------

  const roleLabel = (role) => tr(`role.${role}`);
  const loaded = checks.alwaysLoaded.map((group) => ({
    key: group.project ?? 'user',
    project: group.project,
    label: placeLabel(group.project, group.label),
    lines: group.lines,
    limit: group.limit,
    percent: percent(group.lines, group.limit),
    state: stateOf(group.lines, group.limit),
    files: group.files.map((file) => ({ path: file.path, label: file.label, lines: file.lines, role: file.role, roleLabel: roleLabel(file.role) })),
    excluded: (group.excluded ?? []).map((file) => ({
      path: file.path,
      label: file.label,
      lines: file.lines,
      pattern: file.pattern,
      setting: label(file.setting),
    })),
  }));

  const partLabel = (part) => (part.path ? part.label : tr(`tax.part.${part.type}`, { count: part.count }));
  const stageOf = (part) => {
    if (part.type === 'import') return 'imports';
    if (part.type === 'rule') return 'rules';
    if (part.type === 'auto-memory') return 'autoMemory';
    if (part.type === 'skill-listing' || part.type === 'command-listing') return 'listing';
    return byPath.get(part.path)?.scope === 'user' ? 'user' : 'project';
  };
  const taxPlaces = (checks.contextTax ?? []).map((place) => {
    const stages = { user: 0, project: 0, imports: 0, rules: 0, autoMemory: 0, listing: 0 };
    for (const part of place.parts) stages[stageOf(part)] += part.tokens;
    const contributors = place.parts
      .map((part, index) => ({
        type: part.type,
        typeLabel: tr(`tax.type.${part.type}`),
        label: partLabel(part),
        path: part.path ?? null,
        count: part.count ?? null,
        bytes: part.bytes,
        tokens: part.tokens,
        share: place.tokens ? Math.round((part.tokens / place.tokens) * 100) : 0,
        index,
      }))
      .sort((a, b) => b.tokens - a.tokens || a.index - b.index)
      .map(({ index, ...part }) => part);
    return {
      key: place.key,
      project: place.project,
      label: placeLabel(place.project, place.label),
      tokens: place.tokens,
      bytes: place.bytes,
      contributors,
      stages,
      autoMemory:
        place.autoMemory === null
          ? null
          : {
              found: place.autoMemory.found,
              bytes: place.autoMemory.bytes,
              counted: place.autoMemory.counted,
              label: label(place.autoMemory.path),
              text: place.autoMemory.found
                ? tr('tax.auto.found', { file: label(place.autoMemory.path), bytes: place.autoMemory.bytes, counted: place.autoMemory.counted })
                : tr('tax.auto.missing', { file: label(place.autoMemory.path) }),
            },
    };
  });
  const worstTax = [...taxPlaces].sort((a, b) => b.tokens - a.tokens)[0] ?? null;

  // --- files ----------------------------------------------------------------------------------

  const launchRule = (file) => file.kind === 'rule' && file.loads === 'launch';
  const fileRows = scan.files
    .filter((file) => MEMORY_KINDS.includes(file.kind) || file.kind === 'agents-md' || launchRule(file))
    .map((file) => {
      const limit = MEMORY_KINDS.includes(file.kind) && file.kind !== 'import' ? limits.memoryFileLines.value : null;
      const loads = file.kind === 'import' ? 'launch' : (file.loads ?? 'launch');
      return {
        path: file.path,
        label: label(file.path),
        kind: file.kind,
        kindLabel: tr(`kind.${file.kind}`),
        scope: file.scope,
        project: file.project,
        lines: file.lines,
        bytes: file.bytes,
        tokens: file.approxTokens,
        limit,
        percent: percent(file.lines, limit),
        state: stateOf(file.lines, limit),
        loads,
        loadsLabel: tr(`loads.${loads}`),
      };
    });

  // --- skills ---------------------------------------------------------------------------------

  const skillFiles = scan.files.filter((file) => file.kind === 'skill');
  const userSkills = new Map(skillFiles.filter((file) => file.scope === 'user').map((file) => [file.name, file]));
  const projectCopies = new Map();
  for (const file of skillFiles.filter((item) => item.scope === 'project')) {
    projectCopies.set(file.name, [...(projectCopies.get(file.name) ?? []), file]);
  }
  const findingsBySkill = new Map();
  for (const finding of checks.findings) {
    if (byPath.get(finding.file)?.kind === 'skill') findingsBySkill.set(finding.file, [...(findingsBySkill.get(finding.file) ?? []), finding]);
  }
  const notesBySkill = new Map();
  for (const note of checks.notes ?? []) notesBySkill.set(note.file, [...(notesBySkill.get(note.file) ?? []), note]);

  const descriptionChars = (file) =>
    ['description', 'when_to_use'].reduce((sum, key) => sum + (typeof file.frontMatter?.data?.[key] === 'string' ? file.frontMatter.data[key].trim().length : 0), 0);

  function skillNote(check, file) {
    const data = file.frontMatter?.data ?? {};
    return {
      key: check,
      text: tr(`skillnote.${check}`, {
        chars: descriptionChars(file),
        limit: limits.skillDescriptionChars.value,
        name: typeof data.name === 'string' ? data.name : '',
      }),
    };
  }

  // The steps of a skill, read from its own text. A skill with no recognisable steps has no
  // diagram, and the view says so instead of inventing one.
  function flowOf(file) {
    let source;
    try {
      source = readFileSync(file.path, 'utf8');
    } catch {
      return { source: 'unreadable', steps: 0, capped: 0, graph: null, mermaid: '', text: tr('skills.unreadable') };
    }
    const read = extractFlow(source, { labels: flowLabels });
    if (read.source === 'none') return { source: 'none', steps: 0, capped: 0, graph: null, mermaid: '', text: tr('skills.noSteps') };
    const branches = flows?.[file.path];
    const graph = Array.isArray(branches) && branches.length ? mergeBranches(read, branches, source, { labels: flowLabels }).flow : read;
    return {
      source: graph.source,
      steps: graph.nodes.filter((node) => node.kind === 'step' || node.kind === 'decision').length,
      capped: graph.capped ?? 0,
      graph,
      mermaid: toMermaid(graph),
      text: null,
    };
  }

  function twinOf(file) {
    const others = file.scope === 'user' ? (projectCopies.get(file.name) ?? []) : [userSkills.get(file.name)].filter(Boolean);
    return others.map((other) => {
      const relation = other.contentSha === file.contentSha ? 'same' : 'differs';
      const where = other.scope === 'user' ? tr('skills.user.where') : label(other.project);
      return { relation, path: other.path, label: label(other.path), where, text: tr(`skills.twin.${relation}`, { where }) };
    });
  }

  function skillView(file) {
    const limit = limits.skillLines.value;
    const data = file.frontMatter?.data ?? {};
    const found = findingsBySkill.get(file.path) ?? [];
    const remarks = notesBySkill.get(file.path) ?? [];
    const twins = twinOf(file);
    const thirdParty = file.thirdParty
      ? { reasons: file.thirdParty, text: tr('skills.thirdParty'), because: file.thirdParty.map((reason) => tr(`skills.thirdParty.reason.${reason.split(':')[0]}`, { key: reason.split(':')[1] ?? '' })) }
      : null;
    const notes = [
      ...(thirdParty ? [{ key: 'third-party', text: thirdParty.text }] : []),
      ...[...found, ...remarks].filter((item) => SKILL_NOTE_CHECKS.includes(item.check)).map((item) => skillNote(item.check, file)),
      ...twins.map((twin) => ({ key: `twin-${twin.relation}`, text: twin.text })),
    ];
    const chars = descriptionChars(file);
    return {
      name: file.name,
      path: file.path,
      label: label(file.path),
      linked: false,
      lines: file.lines,
      limit,
      percent: percent(file.lines, limit),
      state: stateOf(file.lines, limit),
      description: { chars, limit: limits.skillDescriptionChars.value, over: chars > limits.skillDescriptionChars.value },
      listed: data['disable-model-invocation'] !== true,
      thirdParty,
      twins,
      notes,
      findings: found.map((finding) => finding.id),
      flow: flowOf(file),
    };
  }

  const linkedRow = (entry) => ({
    name: entry.name,
    path: entry.path,
    label: label(entry.path),
    linked: true,
    lines: null,
    limit: null,
    percent: null,
    state: null,
    description: null,
    listed: null,
    // Somebody else's folder behind a link: marked like any other third-party skill.
    thirdParty: { reasons: ['linked'], text: tr('skills.thirdParty'), because: [tr('skills.thirdParty.reason.linked', { key: '' })] },
    twins: [],
    notes: [{ key: 'linked', text: tr('skills.linked') }],
    findings: [],
    flow: null,
  });

  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  function skillGroup(scope, project) {
    const rows = [
      ...skillFiles.filter((file) => file.scope === scope && file.project === (project?.path ?? null)).map(skillView),
      ...(scan.linked ?? []).filter((entry) => entry.kind === 'skill' && entry.scope === scope && entry.project === (project?.path ?? null)).map(linkedRow),
    ].sort(byName);
    const folder = scope === 'user' ? join(home, '.claude', 'skills') : join(project.path, '.claude', 'skills');
    return {
      key: scope === 'user' ? 'user' : project.path,
      scope,
      project: project?.path ?? null,
      nestedIn: project?.nestedIn ?? null,
      // A project group is headed by the full path of the project, so two projects of one name stay apart.
      title: scope === 'user' ? tr('skills.user.title') : project.path,
      label: scope === 'user' ? null : label(project.path),
      note: project?.nestedIn ? tr('skills.nested', { parent: project.nestedIn }) : null,
      folder,
      folderLabel: label(folder),
      count: rows.length,
      empty: rows.length === 0,
      emptyText: rows.length === 0 ? tr('skills.none') : null,
      rows,
    };
  }
  const skillGroups = [skillGroup('user', null), ...projects.map((project) => skillGroup('project', project))];
  const allSkillRows = skillGroups.flatMap((group) => group.rows);

  // --- the rest of the inventory --------------------------------------------------------------

  const agentsMd = scan.files
    .filter((file) => file.kind === 'agents-md')
    .map((file) => ({
      path: file.path,
      label: label(file.path),
      lines: file.lines,
      loads: file.loads,
      text: tr(`inventory.agentsMd.${file.loads}`, { file: label(file.path), lines: file.lines }),
    }));
  const nested = (scan.nestedRepositories ?? []).map((repository) => {
    const state = repository.included ? 'included' : repository.setup ? 'left-out' : 'no-setup';
    return {
      path: repository.path,
      name: repository.name,
      parent: repository.parent,
      setup: repository.setup,
      included: repository.included,
      state,
      text: tr(`inventory.nested.${state}`, { path: repository.path }),
    };
  });
  // A memory file of a subfolder loads on demand, unless a setting switches it off there.
  const switchedOff = new Set(checks.alwaysLoaded.flatMap((group) => (group.excluded ?? []).map((file) => `${group.project} ${file.path}`)));
  const nestedMemory = scan.files.filter((file) => file.kind === 'memory-nested' && !switchedOff.has(`${file.project} ${file.path}`));
  const onDemand = {
    nestedMemory: nestedMemory.length,
    scopedRules: scan.files.filter((file) => file.kind === 'rule' && file.loads === 'on-demand').length,
  };

  // --- how the setup loads: one small graph per place -------------------------------------------

  function loadGraph(place) {
    const group = checks.alwaysLoaded.find((item) => (item.project ?? 'user') === place.key);
    const sum = (keep) => {
      const files = group.files.filter(keep);
      return { count: files.length, lines: files.reduce((total, file) => total + file.lines, 0) };
    };
    const scopeOf = (file) => (file.project === null ? 'user' : 'project');
    const kindOf = (file) => byPath.get(file.path)?.kind;
    const steps = [
      ['userMemory', sum((file) => file.role === 'memory' && scopeOf(file) === 'user')],
      ['userRules', sum((file) => file.role === 'rule' && scopeOf(file) === 'user')],
      ['projectMemory', sum((file) => file.role === 'memory' && scopeOf(file) === 'project' && kindOf(file) !== 'memory-local')],
      ['projectRules', sum((file) => file.role === 'rule' && scopeOf(file) === 'project')],
      ['localMemory', sum((file) => kindOf(file) === 'memory-local')],
      ['agentsMd', sum((file) => file.role === 'agents-md')],
      ['imports', sum((file) => file.role === 'import')],
    ].filter(([, total]) => total.count > 0);
    const nodes = [{ id: 'start', label: tr('load.start'), kind: 'start' }];
    for (const [key, total] of steps) nodes.push({ id: key, label: tr(`load.${key}`, total), kind: 'step' });
    if (place.autoMemory?.found) nodes.push({ id: 'autoMemory', label: tr('load.autoMemory', { tokens: fmt(place.stages.autoMemory) }), kind: 'step' });
    const listing = place.contributors.filter((part) => part.type === 'skill-listing' || part.type === 'command-listing');
    if (listing.length) {
      nodes.push({ id: 'listing', label: tr('load.listing', { count: listing.reduce((total, part) => total + part.count, 0), tokens: fmt(place.stages.listing) }), kind: 'step' });
    }
    nodes.push({ id: 'total', label: tr('load.total', { tokens: fmt(place.tokens) }), kind: 'step' });
    nodes.push({ id: 'end', label: tr('load.end'), kind: 'end' });
    const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));
    nodes.push({ id: 'later', label: tr('load.later', { nested: place.project === null ? 0 : onDemandIn(place.project), rules: scopedRulesIn(place.project) }), kind: 'note' });
    edges.push({ from: 'end', to: 'later', label: tr('load.later.edge') });
    const graph = { nodes, edges };
    return { key: place.key, label: place.label, title: tr('load.title', { place: place.label }), graph, mermaid: toMermaid(graph) };
  }
  const onDemandIn = (project) => nestedMemory.filter((file) => file.project === project).length;
  const scopedRulesIn = (project) =>
    scan.files.filter((file) => file.kind === 'rule' && file.loads === 'on-demand' && (file.scope === 'user' || file.project === project)).length;
  // The place that costs most comes first; it is the one a report draws open.
  const load = [...taxPlaces].sort((a, b) => b.tokens - a.tokens).map(loadGraph);

  // --- numbers and where they come from -------------------------------------------------------

  const numbers = [
    ...Object.entries(limits).map(([key, limit]) => ({
      key,
      label: tr(`number.${key}`),
      value: limit.value,
      documented: limit.documented,
      carried: carried(limit),
      source: limit.source,
      mark: !limit.documented ? tr('number.default') : carried(limit) ? tr('number.carried') : tr('number.documented'),
    })),
    ...Object.entries(FLOW_LIMITS).map(([key, value]) => ({
      key: `flow.${key}`,
      label: tr(`number.flow.${key}`),
      value,
      documented: false,
      carried: false,
      source: null,
      mark: tr('number.default'),
    })),
  ];

  // --- suggested changes, file by file ---------------------------------------------------------

  // Where a file stands in a file-by-file list, and what is known about it.
  const facts = fileFacts({ scan, checks, lang });
  const fileHead = (group, index, of) => ({ k: index + 1, of, ...facts(group) });

  // The order is that of lib/order.mjs: the walk of cards goes through the same list.
  const changeGroups = byFile(scan, checks.findings);
  let position = 0;
  const changes = {
    total: checks.findings.length,
    files: changeGroups.map((group, index) => {
      const byKind = [];
      const severities = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
      const items = group.items.map((finding) => {
        const kind = finding.suggestion.kind;
        let entry = byKind.find((item) => item.kind === kind);
        if (!entry) byKind.push((entry = { kind, label: tr(`suggestion.${kind}`), count: 0 }));
        entry.count += 1;
        severities[finding.severity] += 1;
        position += 1;
        return {
          id: finding.id,
          n: position,
          check: finding.check,
          where: whereOf(finding),
          line: finding.line,
          severity: finding.severity,
          severityLabel: tr(`severity.${finding.severity}`),
          kind,
          kindLabel: entry.label,
          title: finding.check === 'judgement' ? finding.title : tr(`check.${finding.check}.title`),
          message: finding.message,
        };
      });
      return { ...fileHead(group, index, changeGroups.length), count: items.length, byKind, severities, items };
    }),
  };

  // --- scan notes -----------------------------------------------------------------------------

  const notes = [
    ...(scan.capped?.reasons ?? []).map((reason) => tr('note.capped', { cap: reason.cap, limit: reason.limit, count: reason.count, at: reason.at })),
    ...(scan.skipped ?? []).map((entry) => tr(`note.skipped.${entry.reason}`, { path: entry.path })),
  ];

  const findingTotals = { ...checks.metrics.findings, total: SEVERITIES.reduce((sum, severity) => sum + checks.metrics.findings[severity], 0) };
  const allImports = scan.files.flatMap((file) => file.imports ?? []);
  const worstLoaded = [...loaded].sort((a, b) => b.lines - a.lines)[0];
  const scopeParts = [tr('report.scope.user')];
  if (projects.length) scopeParts.push(tr('report.scope.projects', { count: projects.length }));
  if (scan.scope?.machine) scopeParts.push(tr('report.scope.machine'));
  const includedNested = nested.filter((repository) => repository.included).length;
  if (includedNested) scopeParts.push(tr('report.scope.nested', { count: includedNested }));

  const view = {
    kind: before === null && applied === null ? 'state' : 'after',
    lang,
    generatedAt: now.toISOString(),
    generatedText: tr('report.generated', { date: now.toLocaleString(lang) }),
    home,
    title: tr(before === null && applied === null ? 'report.state.title' : 'report.after.title'),
    factsCheckedOn: checks.factsCheckedOn ?? null,
    scope: {
      text: scopeParts.join(', '),
      // A project is named by its label, which tells two folders of one name apart.
      projects: projects.map((project) => ({ path: project.path, name: label(project.path), nestedIn: project.nestedIn ?? null })),
      machine: Boolean(scan.scope?.machine),
      nested: {
        found: nested.length,
        withSetup: nested.filter((repository) => repository.setup).length,
        included: includedNested,
      },
    },
    counts: {
      files: scan.files.length,
      userFiles: scan.files.filter((file) => file.scope === 'user').length,
      projectFiles: scan.files.filter((file) => file.scope === 'project').length,
      memoryFiles: checks.metrics.memoryFiles,
      memoryLines: checks.metrics.totalLines,
      imports: {
        followed: scan.files.filter((file) => file.kind === 'import').length,
        missing: allImports.filter((entry) => entry.exists === false).length,
        tooDeep: allImports.filter((entry) => entry.tooDeep).length,
      },
      projects: projects.length,
      settings: scan.settings.length,
      checks: checks.metrics.checks ?? null,
      skills: checks.metrics.skills,
      commands: checks.metrics.commands,
      agents: checks.metrics.agents,
      rules: checks.metrics.rules,
      hooks: checks.metrics.hooks,
      findings: findingTotals,
      candidates: candidateCounts,
      review: review.length,
      notes: (checks.notes ?? []).length,
      linkedSkills: (scan.linked ?? []).filter((entry) => entry.kind === 'skill').length,
      thirdPartySkills: allSkillRows.filter((row) => row.thirdParty).length,
    },
    limits: {
      memoryFileLines: limitOf('memoryFileLines'),
      alwaysLoadedLines: limitOf('alwaysLoadedLines'),
      skillLines: limitOf('skillLines'),
      skillDescriptionChars: limitOf('skillDescriptionChars'),
      bytesPerToken: limitOf('bytesPerToken'),
    },
    numbers,
    files: fileRows,
    loaded: { worst: worstLoaded.key, note: tr('section.alwaysLoaded.note', { limit: worstLoaded.limit }), places: loaded },
    contextTax: {
      worst: worstTax?.key ?? null,
      estimate: tr('tax.estimate', { bytes: limits.bytesPerToken.value }),
      notCounted: tr('tax.notCounted'),
      places: taxPlaces,
    },
    load,
    findings: { total: checks.findings.length, none: tr('findings.none'), bySeverity: groupFindings(checks.findings) },
    candidates: {
      ...candidateCounts,
      // One line for a screen that shows no more of them than this.
      sentence: (read === 0 ? tr('candidates.sentence', { count: candidateCounts.total }) : tr('candidates.read', { ...candidateCounts, read })) + leftOut,
      conflictPairs: { ...pairs, text: (pairs.compared ? tr('candidates.pairs', pairs) : tr('candidates.pairs.open', pairs)) + leftOut },
      groups: candidateGroups,
    },
    review: { note: tr('review.note'), items: review },
    skills: {
      total: allSkillRows.length,
      limit: limitOf('skillLines'),
      thirdParty: allSkillRows.filter((row) => row.thirdParty).length,
      thirdPartyText: allSkillRows.some((row) => row.thirdParty) ? tr('skills.thirdParty.note') : tr('skills.thirdParty.none'),
      groups: skillGroups,
    },
    inventory: { agentsMd, nested, nestedHint: nested.some((repository) => repository.state === 'left-out') ? tr('inventory.nested.hint') : null, onDemand },
    changes,
    notes: { none: tr('note.none'), items: notes },
    after: null,
  };

  if (view.kind === 'after') view.after = afterView({ view, scan, checks, before, applied: applied ?? [], tr, label, whereOf, findingView, groupFindings, skillView, byPath, fileHead });
  return clean(view);
}

// What the second report adds: before and after, what was created, what was skipped, what is
// still open, where each entry went and the steps of every skill the run created.
function afterView({ view, scan, checks, before, applied, tr, label, whereOf, findingView, groupFindings, skillView, byPath, fileHead }) {
  // Three things can be recorded for a change: this tool applied it, the person made it by hand
  // (the tool only took a copy first), or it was skipped. Only what the tool applied is counted
  // as applied, drawn as an entry that moved and said to have created something.
  const done = applied.filter((entry) => entry.status === 'applied');
  const byHand = applied.filter((entry) => entry.status === 'by-hand');
  const skipped = applied.filter((entry) => entry.status === 'skipped');
  const changed = [...done, ...byHand];
  const earlier = before ?? checks;
  const beforeFindings = new Map(earlier.findings.map((finding) => [finding.id, finding]));
  const total = (result) => SEVERITIES.reduce((sum, severity) => sum + result.metrics.findings[severity], 0);
  const worstLines = (result) => Math.max(...result.alwaysLoaded.map((group) => group.lines));
  const worstTokens = (result) => (result.contextTax?.length ? Math.max(...result.contextTax.map((place) => place.tokens)) : null);

  const memoryOf = (result) => new Map(result.files.filter((file) => MEMORY_KINDS.includes(file.kind)).map((file) => [file.path, file]));
  const [old, current] = [memoryOf(earlier), memoryOf(checks)];
  const change = (file) => Math.abs((current.get(file)?.lines ?? 0) - (old.get(file)?.lines ?? 0));
  // Files that changed come first; the rest keep the order of the scan.
  const lines = [...new Set([...old.keys(), ...current.keys()])]
    .map((file, index) => ({ file, index }))
    .sort((a, b) => change(b.file) - change(a.file) || a.index - b.index)
    .map(({ file }) => {
      const [a, b] = [old.get(file), current.get(file)];
      return {
        path: file,
        label: (b ?? a).label,
        before: a ? a.lines : null,
        after: b ? b.lines : null,
        diff: (b?.lines ?? 0) - (a?.lines ?? 0),
        status: !a ? 'new' : !b ? 'removed' : null,
        statusLabel: !a ? tr('status.new') : !b ? tr('status.removed') : null,
      };
    });

  const previousLoaded = new Map(earlier.alwaysLoaded.map((group) => [group.project ?? 'user', group.lines]));
  const previousTax = new Map((earlier.contextTax ?? []).map((place) => [place.key, place.tokens]));
  const linesNow = new Map(checks.files.map((file) => [file.path, file.lines]));
  const created = done.flatMap((entry) => entry.created ?? []).map((item) => ({
    type: item.type,
    typeLabel: tr(`created.${item.type}`),
    path: item.path,
    label: label(item.path),
    lines: linesNow.get(item.path) ?? null,
  }));

  // Where each entry went: one arrow per applied change, from the line the person was shown to
  // what it became. Line numbers are those of the first report, the ones the person has seen.
  const moved = { entries: [], graph: null, mermaid: '', title: tr('moved.title') };
  const nodes = [];
  const edges = [];
  const targetIds = new Map();
  done.forEach((entry, index) => {
    const finding = beforeFindings.get(entry.id);
    const from = finding ? whereOf(finding) : entry.files?.length ? label(entry.files[0]) : entry.id;
    const sourceId = `e${index + 1}`;
    // On the node the line is written out, so the label can wrap between words.
    const line = finding?.line ?? null;
    nodes.push({ id: sourceId, label: line === null ? from : tr('moved.source', { line, file: label(finding.file) }), kind: 'step' });
    // A change that created nothing (a rewording, a deleted copy) ends in a box that says what
    // happened; changes of one kind share that box.
    const targets = (entry.created ?? []).length
      ? entry.created.map((item) => ({ key: `${item.type} ${item.path}`, label: label(item.path), type: tr(`created.${item.type}`) }))
      : [{ key: `kind ${entry.kind}`, label: tr(`moved.kind.${entry.kind}`), type: null }];
    for (const target of targets) {
      if (!targetIds.has(target.key)) {
        targetIds.set(target.key, `t${targetIds.size + 1}`);
        nodes.push({ id: targetIds.get(target.key), label: target.label, kind: target.type ? 'step' : 'note' });
      }
      edges.push({ from: sourceId, to: targetIds.get(target.key), ...(target.type ? { label: target.type } : {}) });
      moved.entries.push({ id: entry.id, from, to: target.label, type: target.type, kind: entry.kind, kindLabel: tr(`suggestion.${entry.kind}`) });
    }
  });
  if (nodes.length) {
    moved.graph = { nodes, edges };
    moved.mermaid = toMermaid(moved.graph);
  }

  const createdSkills = done
    .flatMap((entry) => entry.created ?? [])
    .filter((item) => item.type === 'skill' || item.type === 'command')
    .map((item) => byPath.get(item.path))
    .filter((file) => file?.kind === 'skill')
    .map(skillView);

  const next = [];
  if (checks.metrics.findings.high) next.push(tr('next.openHigh', { count: checks.metrics.findings.high }));
  for (const file of view.files) {
    if (file.limit === null || file.lines <= file.limit) continue;
    const sections = (checks.files.find((item) => item.path === file.path)?.largestSections ?? [])
      .map((section) => tr('list.section', { heading: section.heading, lines: section.lines }))
      .join(', ');
    next.push(tr('next.overLimit', { file: file.label, lines: file.lines, limit: file.limit, sections: sections || '-' }));
  }
  const over = view.loaded.places.filter((place) => place.lines > place.limit);
  for (const place of over.some((item) => item.project === null) ? over.slice(0, 1) : over) {
    next.push(tr('next.totalOver', { group: place.label, lines: place.lines, limit: place.limit }));
  }
  const kinds = new Map();
  for (const finding of checks.findings) {
    if (['memory-too-long', 'always-loaded-total'].includes(finding.check)) continue;
    const title = finding.check === 'judgement' ? finding.title : tr(`check.${finding.check}.title`);
    kinds.set(title, (kinds.get(title) ?? 0) + 1);
  }
  for (const [title, count] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 3)) next.push(tr('next.openKind', { count, title }));
  if (skipped.length) next.push(tr('next.skipped', { count: skipped.length }));
  next.push(tr('next.rerun'));

  const backups = [...new Set(changed.map((entry) => entry.backup).filter(Boolean))];
  // A change made by hand in a file this tool may not write to has no copy; without a backup
  // folder on its record there is nothing to undo it from, and the report says so.
  const unbacked = changed.filter((entry) => !entry.backup).length;
  const statusOf = (finding) => (beforeFindings.has(finding.id) ? { key: 'remains', label: tr('status.remains') } : { key: 'new', label: tr('status.newFinding') });

  const appliedView = (entry) => ({
    id: entry.id,
    kind: entry.kind,
    kindLabel: tr(`suggestion.${entry.kind}`),
    where: beforeFindings.has(entry.id) ? whereOf(beforeFindings.get(entry.id)) : null,
    message: beforeFindings.get(entry.id)?.message ?? null,
    files: (entry.files ?? []).map((file) => label(file)),
    note: entry.note ?? null,
  });
  const skippedView = (entry) => ({
    id: entry.id,
    kind: entry.kind,
    kindLabel: tr(`suggestion.${entry.kind}`),
    where: beforeFindings.has(entry.id) ? whereOf(beforeFindings.get(entry.id)) : null,
    finding: beforeFindings.has(entry.id) ? findingView(beforeFindings.get(entry.id)) : null,
    note: entry.note ?? null,
  });

  // File by file, in the order of the walk: what was applied there, what was skipped, and what
  // is still open. A decision sits where its finding sat in the first report; one whose finding
  // is not known sits with the first file it touched.
  const placed = (entry, status) => {
    const finding = beforeFindings.get(entry.id);
    const file = finding?.file ?? entry.files?.[0] ?? null;
    return file === null ? [] : [{ file, line: finding?.line ?? null, endLine: finding?.endLine ?? null, status, entry }];
  };
  const perFile = byFile(scan, [
    ...done.flatMap((entry) => placed(entry, 'applied')),
    ...byHand.flatMap((entry) => placed(entry, 'by-hand')),
    ...skipped.flatMap((entry) => placed(entry, 'skipped')),
    ...checks.findings.map((finding) => ({ file: finding.file, line: finding.line, endLine: finding.endLine, status: 'open', finding })),
  ]);
  const linesBefore = new Map(earlier.files.map((file) => [file.path, file.lines]));
  const files = perFile.map((group, index) => ({
    ...fileHead(group, index, perFile.length),
    linesBefore: linesBefore.get(group.path) ?? null,
    applied: group.items.filter((item) => item.status === 'applied').map((item) => appliedView(item.entry)),
    byHand: group.items.filter((item) => item.status === 'by-hand').map((item) => appliedView(item.entry)),
    skipped: group.items.filter((item) => item.status === 'skipped').map((item) => skippedView(item.entry)),
    open: group.items.filter((item) => item.status === 'open').map((item) => findingView(item.finding, statusOf)),
  }));

  return {
    totals: {
      memoryLines: { before: earlier.metrics.totalLines, after: checks.metrics.totalLines },
      loadedLines: { before: worstLines(earlier), after: worstLines(checks) },
      tokens: { before: worstTokens(earlier), after: worstTokens(checks) },
      findings: { before: total(earlier), after: total(checks) },
      skills: { before: earlier.metrics.skills, after: checks.metrics.skills },
      hooks: { before: earlier.metrics.hooks, after: checks.metrics.hooks },
      applied: done.length,
      byHand: byHand.length,
      skipped: skipped.length,
    },
    lines,
    loaded: view.loaded.places.map((place) => {
      const was = previousLoaded.get(place.key);
      return { ...place, before: was ?? null, diff: was === undefined ? null : place.lines - was };
    }),
    tax: view.contextTax.places.map((place) => {
      const was = previousTax.get(place.key);
      return { key: place.key, label: place.label, before: was ?? null, after: place.tokens, diff: was === undefined ? null : place.tokens - was };
    }),
    created,
    applied: done.map(appliedView),
    byHand: byHand.map(appliedView),
    skipped: skipped.map(skippedView),
    files,
    open: { total: checks.findings.length, none: tr('open.none'), bySeverity: groupFindings(checks.findings, statusOf) },
    next,
    undo: {
      text: backups.length ? tr('undo.text') : null,
      backups,
      unbacked: unbacked ? tr('undo.noBackup', { count: unbacked }) : null,
      none: changed.length ? null : tr('undo.none'),
    },
    moved,
    createdSkills,
  };
}
